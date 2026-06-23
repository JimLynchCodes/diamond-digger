const sqlite3 = require("sqlite3").verbose();

const DATE = "2026-06-23";
const DB_FILE = "mlb.db";

const API_DELAY_MS = 200;

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
            console.log("429 rate limit, sleeping...");
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

        prob_0_h_r_rbi REAL,

        prob_1_plus_h_r_rbi REAL,

        prob_2_plus_h_r_rbi REAL,

        prob_0_hits REAL,

        prob_1_plus_hits REAL,

        prob_2_plus_hits REAL,

        prob_0_runs REAL,

        prob_1_plus_runs REAL,

        prob_2_plus_runs REAL,

        prob_0_rbi REAL,

        prob_1_plus_rbi REAL,

        prob_2_plus_rbi REAL,

        prob_0_totalBases REAL,

        prob_1_plus_totalBases REAL,

        prob_2_plus_totalBases REAL,

        prob_0_homeRuns REAL,

        prob_1_plus_homeRuns REAL,

        prob_2_plus_homeRuns REAL,

        prob_0_strikeOuts REAL,

        prob_1_plus_strikeOuts REAL,

        prob_2_plus_strikeOuts REAL,


        raw_stats_json TEXT,


        UNIQUE(game_pk, player_id)

    )

    `);

}


// --------------------------------
// Poisson
// --------------------------------

function poisson(lambda_h_r_rbi, lambda_hits, lambda_runs, lambda_rbi,
    lambda_totalBases, lambda_homeRuns, lambda_strikeOuts) {

    const p0_h_r_rbi =
        Math.exp(-lambda_h_r_rbi);

    const p1_h_r_rbi =
        lambda_h_r_rbi * p0_h_r_rbi;

    const p0_hits =
        Math.exp(-lambda_hits);

    const p1_hits =
        lambda_hits * p0_hits;
        
    const p0_runs =
        Math.exp(-lambda_runs);

    const p1_runs =
        lambda_runs * p0_runs;

    const p0_rbi =
        Math.exp(-lambda_rbi);

    const p1_rbi =
        lambda_rbi * p0_rbi;

    const p0_totalBases =
        Math.exp(-lambda_totalBases);

    const p1_totalBases =
        lambda_totalBases * p0_totalBases;

    const p0_homeRuns =
        Math.exp(-lambda_homeRuns);

    const p1_homeRuns =
        lambda_homeRuns * p0_homeRuns;

    const p0_strikeOuts =
        Math.exp(-lambda_strikeOuts);

    const p1_strikeOuts =
        lambda_strikeOuts * p0_strikeOuts;

    return {

        prob_0_h_r_rbi:
            round3(p0_h_r_rbi),

        // prob_1_h_r_rbi:
        //     round3(p1_h_r_rbi),

        prob_1_plus_h_r_rbi:
            round3(1 - p0_h_r_rbi),

        prob_2_plus_h_r_rbi:
            round3(1 - p0_h_r_rbi - p1_h_r_rbi),

        // prob_0_or_1_h_r_rbi:
        //     round3(p0_h_r_rbi + p1_h_r_rbi),


        prob_0_hits:
            round3(p0_hits),

        prob_1_plus_hits:
            round3(1 - p0_hits),

        prob_2_plus_hits:
            round3(1 - p0_hits - p1_hits),


        prob_0_runs:
            round3(p0_runs),

        prob_1_plus_runs:
            round3(1 - p0_runs),

        prob_2_plus_runs:
            round3(1 - p0_runs - p1_runs),


        prob_0_rbi:
            round3(p0_rbi),

        prob_1_plus_rbi:
            round3(1 - p0_rbi),

        prob_2_plus_rbi:
            round3(1 - p0_rbi - p1_rbi),


        prob_0_totalBases:
            round3(p0_totalBases),

        prob_1_plus_totalBases:
            round3(1 - p0_totalBases),

        prob_2_plus_totalBases:
            round3(1 - p0_totalBases - p1_totalBases),


        prob_0_homeRuns:
            round3(p0_homeRuns),

        prob_1_plus_homeRuns:
            round3(1 - p0_homeRuns),

        prob_2_plus_homeRuns:
            round3(1 - p0_homeRuns - p1_homeRuns),


        prob_0_strikeOuts:
            round3(p0_strikeOuts),

        prob_1_plus_strikeOuts:
            round3(1 - p0_strikeOuts),

        prob_2_plus_strikeOuts:
            round3(1 - p0_strikeOuts - p1_strikeOuts),


    };

}



// --------------------------------
// ONLY battingOrder
// --------------------------------

function getBattingOrder(team) {

    if (team.battingOrder &&  team.battingOrder.length > 0) {
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

    const url = `https://statsapi.mlb.com/api/v1/people/${playerId}/stats` +
        `?stats=season&group=hitting`;

    const stats =
        await fetchJson(url);

    const split = stats?.stats?.[0]?.splits?.[0];

    const stat = split?.stat;

    const playerName = split?.player?.fullName ?? `Unknown ${playerId}`;

    console.log(side, lineupPosition + 1, playerName);

    if (!stat) {

        console.log("No stats:", playerName);

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

    const plateAppearances = Number(stat.plateAppearances ?? stat.atBats ?? 1);

    const perPaRate_h_r_rbi = (Number(stat.hits || 0) + Number(stat.runs || 0) + Number(stat.rbi || 0)) / plateAppearances;

    const perPaRate_hits = Number(stat.hits || 0) / plateAppearances;
    const perPaRate_runs = Number(stat.runs || 0) / plateAppearances;
    const perPaRate_rbis = Number(stat.rbi || 0) / plateAppearances;
    const perPaRate_homeRuns = Number(stat.homeRuns || 0) / plateAppearances;
    const perPaRate_totalBases = Number(stat.totalBases || 0) / plateAppearances;
    const perPaRate_strikeOuts = Number(stat.strikeOuts || 0) / plateAppearances;


    const lambda_h_r_rbi = perPaRate_h_r_rbi * projectedPA;

    const lambda_hits = perPaRate_hits * projectedPA;

    const lambda_runs = perPaRate_runs * projectedPA;

    const lambda_rbis = perPaRate_rbis * projectedPA;

    const lambda_homeRuns = perPaRate_homeRuns * projectedPA;

    const lambda_totalBases = perPaRate_totalBases * projectedPA;

    const lambda_strikeOuts = perPaRate_strikeOuts * projectedPA;

    return {

        player_name: playerName,

        home_away: side,

        // lambda_h_r_rbi: round3(lambda_h_r_rbi),
        // lambda_hits: round3(lambda_hits),
        // lambda_runs: round3(lambda_runs),
        // lambda_rbis: round3(lambda_rbis),
        // lambda_homeRuns: round3(lambda_homeRuns),
        // lambda_totalBases: round3(lambda_totalBases),
        // lambda_strikeOuts: round3(lambda_strikeOuts),

        ...poisson(lambda_h_r_rbi, lambda_hits, lambda_runs, 
            lambda_rbis, lambda_totalBases, lambda_homeRuns, lambda_strikeOuts),

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


        prob_0_h_r_rbi,

        prob_1_plus_h_r_rbi,

        prob_2_plus_h_r_rbi,


        prob_0_hits,

        prob_1_plus_hits,

        prob_2_plus_hits,


        prob_0_runs,

        prob_1_plus_runs,

        prob_2_plus_runs,


        prob_0_rbi,

        prob_1_plus_rbi,

        prob_2_plus_rbi,


        prob_0_totalBases,

        prob_1_plus_totalBases,

        prob_2_plus_totalBases,


        prob_0_homeRuns,

        prob_1_plus_homeRuns,

        prob_2_plus_homeRuns,


        prob_0_strikeOuts,

        prob_1_plus_strikeOuts,

        prob_2_plus_strikeOuts,


        raw_stats_json

    )

    VALUES

    (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)


    ON CONFLICT(game_pk, player_id)

    DO UPDATE SET

        player_name = excluded.player_name,

        home_away = excluded.home_away,

        lineup_position = excluded.lineup_position,

        prob_0_h_r_rbi = excluded.prob_0_h_r_rbi,

        prob_1_plus_h_r_rbi = excluded.prob_1_plus_h_r_rbi,

        prob_2_plus_h_r_rbi = excluded.prob_2_plus_h_r_rbi,


        prob_0_hits = excluded.prob_0_hits,

        prob_1_plus_hits = excluded.prob_1_plus_hits,

        prob_2_plus_hits = excluded.prob_2_plus_hits,


        prob_0_runs = excluded.prob_0_runs,

        prob_1_plus_runs = excluded.prob_1_plus_runs,

        prob_2_plus_runs = excluded.prob_2_plus_runs,


        prob_0_rbi = excluded.prob_0_rbi,

        prob_1_plus_rbi = excluded.prob_1_plus_rbi,

        prob_2_plus_rbi = excluded.prob_2_plus_rbi,


        prob_0_totalBases = excluded.prob_0_totalBases,

        prob_1_plus_totalBases = excluded.prob_1_plus_totalBases,

        prob_2_plus_totalBases = excluded.prob_2_plus_totalBases,


        prob_0_homeRuns = excluded.prob_0_homeRuns,

        prob_1_plus_homeRuns = excluded.prob_1_plus_homeRuns,

        prob_2_plus_homeRuns = excluded.prob_2_plus_homeRuns,


        prob_0_strikeOuts = excluded.prob_0_strikeOuts,

        prob_1_plus_strikeOuts = excluded.prob_1_plus_strikeOuts,

        prob_2_plus_strikeOuts = excluded.prob_2_plus_strikeOuts,


        raw_stats_json = excluded.raw_stats_json


    `,

    [

        gamePk,

        playerId,

        projection.player_name,

        projection.home_away,

        lineupPosition + 1,

        projection.prob_0_h_r_rbi,

        projection.prob_1_plus_h_r_rbi,

        projection.prob_2_plus_h_r_rbi,


        projection.prob_0_hits,

        projection.prob_1_plus_hits,

        projection.prob_2_plus_hits,


        projection.prob_0_runs,

        projection.prob_1_plus_runs,

        projection.prob_2_plus_runs,


        projection.prob_0_rbi,

        projection.prob_1_plus_rbi,

        projection.prob_2_plus_rbi,


        projection.prob_0_totalBases,

        projection.prob_1_plus_totalBases,

        projection.prob_2_plus_totalBases,


        projection.prob_0_homeRuns,

        projection.prob_1_plus_homeRuns,

        projection.prob_2_plus_homeRuns,


        projection.prob_0_strikeOuts,

        projection.prob_1_plus_strikeOuts,

        projection.prob_2_plus_strikeOuts,


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

        const playerId = battingOrder[i];

        const projection = await calculateBatter(playerId, i, side);

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

            console.log("\nGAME", game.gamePk);

            const boxscore = await fetchJson(`https://statsapi.mlb.com/api/v1/game/${game.gamePk}/boxscore`);

            const homeOrder = getBattingOrder(boxscore.teams.home);

            const awayOrder = getBattingOrder(boxscore.teams.away);

            await processTeam(game.gamePk, homeOrder, "home");

            await processTeam(game.gamePk, awayOrder, "away");

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