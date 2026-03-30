const { pool } = require('./db');

async function InitDb() {
    // -------------------------
    // USERS
    // -------------------------
    await pool.query(`
        CREATE TABLE IF NOT EXISTS Users (
            Id BIGSERIAL PRIMARY KEY,
            CreatedAt TIMESTAMP NOT NULL DEFAULT NOW()
        );
    `);
    // -------------------------
    // ACCESS LOGS (AUDIT / 5 W's)
    // -------------------------
    await pool.query(`
    CREATE TABLE IF NOT EXISTS AccessLogs (
        Id BIGSERIAL PRIMARY KEY,

        Action VARCHAR(50) NOT NULL,        -- what happened (LINK, GET_INFO, REMOVE_LINK)
        ActorPlatform VARCHAR(20),          -- who did it (discord, api, etc)
        ActorId BIGINT,                     -- who did it (user/admin id)

        TargetUserId BIGINT,                -- affected user (internal user id)

        TargetPlatform VARCHAR(20),         -- what account was affected
        TargetPlatformId BIGINT,

        Metadata JSONB,                     -- extra info (ip, code, etc)

        CreatedAt TIMESTAMP NOT NULL DEFAULT NOW()
    );
`);


    // -------------------------
    // PLATFORM ACCOUNTS
    // -------------------------
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

    // -------------------------
    // LINK CODES
    // -------------------------
    await pool.query(`
        CREATE TABLE IF NOT EXISTS LinkCodes (
            Code VARCHAR(10) PRIMARY KEY, -- store ONLY the stripped code (ABC123)
            Platform VARCHAR(20) NOT NULL,
            PlatformId BIGINT NOT NULL,
            CreatedAt TIMESTAMP NOT NULL DEFAULT NOW(),
            ExpiresAt TIMESTAMP NOT NULL,
            Used BOOLEAN NOT NULL DEFAULT FALSE
        );
    `);

    // -------------------------
    // ENTITLEMENTS
    // -------------------------
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

    // -------------------------
    // INDEXES
    // -------------------------
    await pool.query(`
        CREATE INDEX IF NOT EXISTS IdxUserAccountsUserId
        ON UserAccounts (UserId);
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS IdxLinkCodesPlatform
        ON LinkCodes (Platform, PlatformId);
    `);
    await pool.query(`
    CREATE INDEX IF NOT EXISTS IdxAccessLogsUser
    ON AccessLogs (TargetUserId);
`);
}

module.exports = InitDb;