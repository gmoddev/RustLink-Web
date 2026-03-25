const { pool } = require('./db');

async function InitDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS UserLinks (
            Id BIGSERIAL PRIMARY KEY,
            SteamId BIGINT NOT NULL UNIQUE,
            DiscordId BIGINT NOT NULL UNIQUE,
            LinkedAt TIMESTAMP NOT NULL DEFAULT NOW()
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS LinkCodes (
            Code VARCHAR(10) PRIMARY KEY,
            SteamId BIGINT NOT NULL,
            CreatedAt TIMESTAMP NOT NULL DEFAULT NOW(),
            ExpiresAt TIMESTAMP NOT NULL,
            Used BOOLEAN NOT NULL DEFAULT FALSE
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS Entitlements (
            SteamId BIGINT NOT NULL,
            Key TEXT NOT NULL,
            Value BOOLEAN NOT NULL DEFAULT FALSE,
            LastUpdated TIMESTAMP NOT NULL DEFAULT NOW(),
            PRIMARY KEY (SteamId, Key)
        );
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS IdxLinkCodesSteamId
        ON LinkCodes (SteamId);
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS IdxUserLinksDiscordId
        ON UserLinks (DiscordId);
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS IdxUserLinksSteamId
        ON UserLinks (SteamId);
    `);
}

module.exports = InitDb;