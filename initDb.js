const { pool } = require('./db');

async function InitDb() {
    // Core users
    await pool.query(`
        CREATE TABLE IF NOT EXISTS Users (
            Id BIGSERIAL PRIMARY KEY,
            CreatedAt TIMESTAMP NOT NULL DEFAULT NOW()
        );
    `);

    // Platform accounts
    await pool.query(`
        CREATE TABLE IF NOT EXISTS UserAccounts (
            UserId BIGINT NOT NULL,
            Platform VARCHAR(20) NOT NULL,
            PlatformId BIGINT NOT NULL,

            PRIMARY KEY (Platform, PlatformId),
            UNIQUE (UserId, Platform),

            FOREIGN KEY (UserId) REFERENCES Users(Id) ON DELETE CASCADE
        );
    `);

    // Link codes (now platform-agnostic)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS LinkCodes (
            Code VARCHAR(10) PRIMARY KEY,
            Platform VARCHAR(20) NOT NULL,
            PlatformId BIGINT NOT NULL,
            CreatedAt TIMESTAMP NOT NULL DEFAULT NOW(),
            ExpiresAt TIMESTAMP NOT NULL,
            Used BOOLEAN NOT NULL DEFAULT FALSE
        );
    `);

    // Entitlements (user-based)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS Entitlements (
            UserId BIGINT NOT NULL,
            Key TEXT NOT NULL,
            Value BOOLEAN NOT NULL DEFAULT FALSE,
            LastUpdated TIMESTAMP NOT NULL DEFAULT NOW(),
            PRIMARY KEY (UserId, Key),
            FOREIGN KEY (UserId) REFERENCES Users(Id) ON DELETE CASCADE
        );
    `);

    // Indexes
    await pool.query(`
        CREATE INDEX IF NOT EXISTS IdxUserAccountsUserId
        ON UserAccounts (UserId);
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS IdxLinkCodesPlatform
        ON LinkCodes (Platform, PlatformId);
    `);
}

module.exports = InitDb;