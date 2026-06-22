const sqlite3 = require("sqlite3").verbose();

const DATE = "2026-06-22";
const DB_FILE = "mlb.db";

const API_DELAY_MS = 2000;

const safeDate = DATE.replace(/-/g, "_");

const PLAYERS_TABLE = `players_${safeDate}`;

const db = new sqlite3.Database(DB_FILE);


// --------------------------------
// Helpers
// --------------------------------

function sleep(ms) {

    return new Promise(resolve =>
        setTimeout(resolve, ms)
    );

}


function run(sql, params = []) {

    return new Promise((resolve, reject) => {

        db.run(sql, params, function(err) {

            if (err)
                reject(err);
            else
                resolve(this);

        });

    });

}



async function fetchJson(url) {


    while (true) {


        await sleep(
            API_DELAY_MS +
            Math.random() * API_DELAY_MS
        );


        console.log("GET:", url);



        const response =
            await fetch(url);



        if (response.status === 429) {


            console.log(
                "429 rate limit, sleeping..."
            );


            await sleep(10000);


            continue;

        }



        if (!response.ok) {


            throw new Error(
                `${response.status} ${url}`
            );

        }



        return response.json();


    }

}



function round3(value) {

    return Number(
        Number(value).toFixed(3)
    );

}



// --------------------------------
// Database
// --------------------------------

async function createTables() {


    await run(`

    CREATE TABLE IF NOT EXISTS ${PLAYERS_TABLE} (

        id INTEGER PRIMARY KEY AUTOINCREMENT,


        game_pk INTEGER,


        player_id INTEGER,


        player_name TEXT,


        home_away TEXT,


        lineup_position INTEGER,


        lambda_h_r_rbi REAL,


        prob_0_h_r_rbi REAL,

        prob_1_h_r_rbi REAL,

        prob_1_plus_h_r_rbi REAL,

        prob_2_plus_h_r_rbi REAL,

        prob_0_or_1_h_r_rbi REAL,


        raw_stats_json TEXT,


        UNIQUE(game_pk, player_id)

    )

    `);


}



// --------------------------------
// Poisson
// --------------------------------

function poisson(lambda) {


    const p0 =
        Math.exp(-lambda);


    const p1 =
        lambda * p0;



    return {


        prob_0_h_r_rbi:
            round3(p0),


        prob_1_h_r_rbi:
            round3(p1),


        prob_1_plus_h_r_rbi:
            round3(1 - p0),


        prob_2_plus_h_r_rbi:
            round3(1 - p0 - p1),


        prob_0_or_1_h_r_rbi:
            round3(p0 + p1)

    };

}



// --------------------------------
// ONLY battingOrder
// --------------------------------

function getBattingOrder(team) {


    if (

        team.battingOrder &&

        team.battingOrder.length > 0

    ) {


        return team.battingOrder;


    }


    return [];


}



// --------------------------------
// Player calculation
// --------------------------------

async function calculateBatter(
    playerId,
    lineupPosition,
    side
) {


    const url =

        `https://statsapi.mlb.com/api/v1/people/${playerId}/stats` +

        `?stats=season&group=hitting`;



    const stats =
        await fetchJson(url);



    const split =

        stats?.stats?.[0]

            ?.splits?.[0];



    const stat =
        split?.stat;



    const playerName =

        split?.player?.fullName ??

        `Unknown ${playerId}`;



    console.log(

        side,

        lineupPosition + 1,

        playerName

    );



    if (!stat) {


        console.log(
            "No stats:",
            playerName
        );


        return null;


    }



    const expectedPA = {


        home: [

            4.55,
            4.42,
            4.28,
            4.15,
            4.01,
            3.88,
            3.72,
            3.58,
            3.40

        ],


        away: [

            4.60,
            4.54,
            4.45,
            4.32,
            4.20,
            4.08,
            3.92,
            3.78,
            3.62

        ]

    };



    const projectedPA =

        expectedPA[side][
            Math.min(lineupPosition, 8)
        ];



    const plateAppearances =

        Number(

            stat.plateAppearances ??

            stat.atBats ??

            1

        );



    const rate =


        (

            Number(stat.hits || 0)

            +

            Number(stat.runs || 0)

            +

            Number(stat.rbi || 0)

        )

        /

        plateAppearances;



    const lambda =

        rate *

        projectedPA;



    return {


        player_name: playerName,


        home_away: side,


        lambda_h_r_rbi:

            round3(lambda),



        ...poisson(lambda),



        raw_stats: stats


    };


}



// --------------------------------
// Save
// --------------------------------

async function saveProjection(
    gamePk,
    playerId,
    lineupPosition,
    projection
) {


    await run(`

    INSERT INTO ${PLAYERS_TABLE}

    (

        game_pk,

        player_id,

        player_name,

        home_away,

        lineup_position,


        lambda_h_r_rbi,


        prob_0_h_r_rbi,

        prob_1_h_r_rbi,

        prob_1_plus_h_r_rbi,

        prob_2_plus_h_r_rbi,

        prob_0_or_1_h_r_rbi,


        raw_stats_json

    )


    VALUES

    (?,?,?,?,?,?,?,?,?,?,?,?)



    ON CONFLICT(game_pk, player_id)

    DO UPDATE SET


        player_name = excluded.player_name,

        home_away = excluded.home_away,

        lineup_position = excluded.lineup_position,

        lambda_h_r_rbi = excluded.lambda_h_r_rbi,

        prob_0_h_r_rbi = excluded.prob_0_h_r_rbi,

        prob_1_h_r_rbi = excluded.prob_1_h_r_rbi,

        prob_1_plus_h_r_rbi = excluded.prob_1_plus_h_r_rbi,

        prob_2_plus_h_r_rbi = excluded.prob_2_plus_h_r_rbi,

        prob_0_or_1_h_r_rbi = excluded.prob_0_or_1_h_r_rbi,

        raw_stats_json = excluded.raw_stats_json


    `,

    [

        gamePk,

        playerId,

        projection.player_name,

        projection.home_away,

        lineupPosition + 1,


        projection.lambda_h_r_rbi,


        projection.prob_0_h_r_rbi,

        projection.prob_1_h_r_rbi,

        projection.prob_1_plus_h_r_rbi,

        projection.prob_2_plus_h_r_rbi,

        projection.prob_0_or_1_h_r_rbi,


        JSON.stringify(
            projection.raw_stats
        )

    ]);


}



// --------------------------------
// Process lineup
// --------------------------------

async function processTeam(
    gamePk,
    battingOrder,
    side
) {


    console.log(
        side,
        "PLAYERS",
        battingOrder.length
    );



    for (
        let i = 0;
        i < battingOrder.length;
        i++
    ) {


        const playerId =
            battingOrder[i];



        const projection =

            await calculateBatter(

                playerId,

                i,

                side

            );



        if (!projection)
            continue;



        await saveProjection(

            gamePk,

            playerId,

            i,

            projection

        );


    }

}



// --------------------------------
// Main
// --------------------------------

async function main() {


    await createTables();



    const schedule =

        await fetchJson(

            `https://statsapi.mlb.com/api/v1/schedule` +

            `?sportId=1&date=${DATE}`

        );



    for (const day of schedule.dates ?? []) {


        for (const game of day.games ?? []) {


            console.log(
                "\nGAME",
                game.gamePk
            );



            const boxscore =

                await fetchJson(

                    `https://statsapi.mlb.com/api/v1/game/${game.gamePk}/boxscore`

                );



            const homeOrder =

                getBattingOrder(
                    boxscore.teams.home
                );



            const awayOrder =

                getBattingOrder(
                    boxscore.teams.away
                );



            await processTeam(

                game.gamePk,

                homeOrder,

                "home"

            );



            await processTeam(

                game.gamePk,

                awayOrder,

                "away"

            );


        }

    }



    db.close();


    console.log("DONE");


}



main()

.catch(err => {


    console.error(err);


    db.close();


});