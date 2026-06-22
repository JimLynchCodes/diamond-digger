const sqlite3 = require("sqlite3").verbose();

const DATE = "2026-06-20";
const DB_FILE = "mlb.db";
const API_DELAY_MS = 200;

const safeDate = DATE.replace(/-/g, "_");

const SCHEDULE_TABLE = `schedule_${safeDate}`;
const TEAMS_TABLE = `teams_${safeDate}`;
const PLAYERS_TABLE = `players_${safeDate}`;

const db = new sqlite3.Database(DB_FILE);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

async function throttledFetch(url) {
    await sleep(API_DELAY_MS / 2 + Math.random() * API_DELAY_MS);

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(
            `HTTP ${response.status} ${response.statusText} - ${url}`
        );
    }

    return response.json();
}

async function createTables() {
    await run(`
    CREATE TABLE IF NOT EXISTS ${SCHEDULE_TABLE} (
      game_pk INTEGER PRIMARY KEY,
      game_date TEXT,
      home_team_id INTEGER,
      home_team_name TEXT,
      away_team_id INTEGER,
      away_team_name TEXT,
      raw_json TEXT
    )
  `);

    await run(`
    CREATE TABLE IF NOT EXISTS ${TEAMS_TABLE} (
      team_id INTEGER PRIMARY KEY,
      team_name TEXT,
      roster_count INTEGER,
      raw_json TEXT
    )
  `);

    await run(`
    CREATE TABLE IF NOT EXISTS ${PLAYERS_TABLE} (
      player_id INTEGER PRIMARY KEY,
      team_id INTEGER,
      player_name TEXT,
      position TEXT,

      games_played INTEGER,
      at_bats INTEGER,
      runs INTEGER,
      hits INTEGER,
      doubles INTEGER,
      triples INTEGER,
      home_runs INTEGER,
      rbi INTEGER,
      stolen_bases INTEGER,

      avg TEXT,
      obp TEXT,
      slg TEXT,
      ops TEXT,

      raw_player_json TEXT,
      raw_stats_json TEXT,
      props_json TEXT
    )
  `);
}

async function importSchedule() {
    const url =
        `https://statsapi.mlb.com/api/v1/schedule` +
        `?sportId=1&date=${DATE}`;

    console.log("Downloading schedule...");

    const schedule = await throttledFetch(url);

    const teams = new Map();

    for (const date of schedule.dates ?? []) {
        for (const game of date.games ?? []) {
            const home = game.teams.home.team;
            const away = game.teams.away.team;

            await run(
                `
        INSERT OR REPLACE INTO ${SCHEDULE_TABLE}
        (
          game_pk,
          game_date,
          home_team_id,
          home_team_name,
          away_team_id,
          away_team_name,
          raw_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
                [
                    game.gamePk,
                    game.gameDate,
                    home.id,
                    home.name,
                    away.id,
                    away.name,
                    JSON.stringify(game)
                ]
            );

            teams.set(home.id, home.name);
            teams.set(away.id, away.name);
        }
    }

    return teams;
}

async function importRoster(teamId, teamName) {
    const url =
        `https://statsapi.mlb.com/api/v1/teams/${teamId}/roster`;

    const rosterData = await throttledFetch(url);

    const roster = rosterData.roster ?? [];

    await run(
        `
    INSERT OR REPLACE INTO ${TEAMS_TABLE}
    (
      team_id,
      team_name,
      roster_count,
      raw_json
    )
    VALUES (?, ?, ?, ?)
    `,
        [
            teamId,
            teamName,
            roster.length,
            JSON.stringify(rosterData)
        ]
    );

    return roster;
}

async function importPlayer(teamId, player) {

    console.log('player')
    console.log(player)

    const playerId = player.person.id;
    const playerName = player.person.fullName;

    const statsUrl =
        `https://statsapi.mlb.com/api/v1/people/${playerId}/stats` +
        `?stats=season&group=hitting`;

    let statsJson = {};

    try {
        console.log("calling f or player")
        statsJson = await throttledFetch(statsUrl);
        console.log("got player stats " + JSON.stringify(statsJson, null, 2))
    } catch (err) {
        console.error(
            `Stats fetch failed for ${playerName} (${playerId})`
        );
    }

    if (statsJson.stats.length > 0) {


        const stat =
            statsJson?.stats?.[0]?.splits?.[0]?.stat ?? {};

        const props = addPlayerPropCalculations(stat);

        console.log("p");
        console.log(props);

        await run(
            `
          INSERT OR REPLACE INTO ${PLAYERS_TABLE}
          (
            player_id,
            team_id,
            player_name,
            position,
            
            games_played,
            at_bats,
            runs,
            hits,
            doubles,
            triples,
            home_runs,
            rbi,
            stolen_bases,
            
            avg,
            obp,
            slg,
            ops,
            
            raw_player_json,
            raw_stats_json,
            props_json
            )
            VALUES (
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?
                )
                `,
            [
                playerId,
                teamId,
                playerName,
                player.position?.abbreviation ?? null,

                stat.gamesPlayed ?? null,
                stat.atBats ?? null,
                stat.runs ?? null,
                stat.hits ?? null,
                stat.doubles ?? null,
                stat.triples ?? null,
                stat.homeRuns ?? null,
                stat.rbi ?? null,
                stat.stolenBases ?? null,

                stat.avg ?? null,
                stat.obp ?? null,
                stat.slg ?? null,
                stat.ops ?? null,

                JSON.stringify(player),
                JSON.stringify(statsJson),
                JSON.stringify(props),
            ]
        );
    }
}

function addPlayerPropCalculations(stat) {

  console.log('stat')
  console.log(stat)

  const games = stat.gamesPlayed;

  console.log("games played: " + games)

  if (!games || games === 0) {
    return null;
  }

  // Per game averages
  const hitsPerGame = stat.hits / games;
  const strikeoutsPerGame = stat.strikeOuts / games;
  const runsPerGame = stat.runs / games;
  const rbiPerGame = stat.rbi / games;

  const hrrbiPerGame =
    (stat.hits + stat.runs + stat.rbi) / games;


  // Probability of 1+
  const prob1Plus = (rate) => {
    return 1 - Math.exp(-rate);
  };


  // Fair American odds
  const fairOdds = (prob) => {
    if (prob >= 1) return null;

    return -(prob / (1 - prob)) * 100;
  };


  // Probabilities
  const probHits1Plus =
    prob1Plus(hitsPerGame);

  const probStrikeouts1Plus =
    prob1Plus(strikeoutsPerGame);

  const probRuns1Plus =
    prob1Plus(runsPerGame);

  const probRbi1Plus =
    prob1Plus(rbiPerGame);

  const probHrrbi1Plus =
    prob1Plus(hrrbiPerGame);


  return {

    // averages
    hits_per_game_played: hitsPerGame,
    strikeouts_per_game_played: strikeoutsPerGame,
    runs_per_game_played: runsPerGame,
    rbi_per_game_played: rbiPerGame,
    h_r_rbi_per_game_played: hrrbiPerGame,


    // hits
    prob_hits_1_plus: probHits1Plus,
    fair_odds_hits_1_plus: fairOdds(probHits1Plus),


    // strikeouts
    prob_strikeouts_1_plus: probStrikeouts1Plus,
    fair_odds_strikeouts_1_plus: fairOdds(probStrikeouts1Plus),


    // runs
    prob_runs_1_plus: probRuns1Plus,
    fair_odds_runs_1_plus: fairOdds(probRuns1Plus),


    // RBI
    prob_rbi_1_plus: probRbi1Plus,
    fair_odds_rbi_1_plus: fairOdds(probRbi1Plus),


    // H+R+RBI
    prob_h_r_rbi_1_plus: probHrrbi1Plus,
    fair_odds_h_r_rbi_1_plus: fairOdds(probHrrbi1Plus)
  };
}

async function main() {
    await createTables();

    const teams = await importSchedule();

    console.log(`Found ${teams.size} teams`);

    for (const [teamId, teamName] of teams.entries()) {
        console.log(`\n${teamName}`);

        let roster;

        try {
            roster = await importRoster(teamId, teamName);
        } catch (err) {
            console.error(`Roster fetch failed for ${teamName}`);
            continue;
        }

        console.log(`Roster size: ${roster.length}`);

        await sleep(API_DELAY_MS / 2 + Math.random() * API_DELAY_MS);

        for (const player of roster) {
            const playerName = player.person.fullName;

            process.stdout.write(`  ${playerName}\n`);

            try {
                await importPlayer(teamId, player);
            } catch (err) {
                console.error(
                    `Failed player import: ${playerName}`
                );
            }
        }
    }

    db.close();

    console.log("\nDone.");
}

main().catch(err => {
    console.error(err);
    db.close();
});