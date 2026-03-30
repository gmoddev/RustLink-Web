const express = require('express');
const Router = express.Router();

const { pool } = require('../db');
const AuthMiddleware = require('../middleware/auth');

// -------------------------
// HELPERS
// -------------------------
function ParseCode(Code) {
    const Clean = Code.toLowerCase().trim();

    if (Clean.startsWith('rbx-')) {
        return {
            platform: 'roblox',
            code: Clean.substring(4).toUpperCase()
        };
    }

    if (Clean.startsWith('stm-')) {
        return {
            platform: 'steam',
            code: Clean.substring(4).toUpperCase()
        };
    }

    return null;
}

function GenerateCode(prefix) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';

    for (let i = 0; i < 6; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }

    return `${prefix}-${result}`;
}

async function CreateLinkCode(Client, Platform, PlatformId, Code) {
    const ExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await Client.query(
        `DELETE FROM LinkCodes WHERE Platform = $1 AND PlatformId = $2`,
        [Platform, PlatformId]
    );

    await Client.query(
        `INSERT INTO LinkCodes (Code, Platform, PlatformId, ExpiresAt, Used)
         VALUES ($1, $2, $3, $4, FALSE)`,
        [Code, Platform, PlatformId, ExpiresAt]
    );
}

// -------------------------
// GENERATE CODE (GENERIC)
// -------------------------
Router.post('/generate-code', AuthMiddleware, async (req, res) => {
    const { platform, platformId } = req.body;

    if (!platform || !platformId) {
        return res.status(400).json({ success: false });
    }

    const prefix = platform === 'roblox' ? 'rbx' :
        platform === 'steam' ? 'stm' : null;

    if (!prefix) {
        return res.status(400).json({ success: false, error: 'Invalid platform' });
    }

    const Client = await pool.connect();

    try {
        const FullCode = GenerateCode(prefix);
        const Parsed = ParseCode(FullCode);

        await Client.query('BEGIN');

        await CreateLinkCode(Client, platform, platformId, Parsed.code);

        await Client.query('COMMIT');

        return res.json({
            success: true,
            code: FullCode
        });

    } catch (err) {
        await Client.query('ROLLBACK');
        console.error(err);
        return res.status(500).json({ success: false });
    } finally {
        Client.release();
    }
});

// -------------------------
// LINK ACCOUNT (FIXED)
// -------------------------
Router.post('/link', AuthMiddleware, async (req, res) => {
    const discordId = req.body.discordId;
    const rawCode = req.body.code?.toString();

    if (!discordId || !rawCode) {
        return res.status(400).json({
            success: false,
            error: 'code and discordId are required'
        });
    }

    const Parsed = ParseCode(rawCode);
    if (!Parsed) {
        return res.json({ success: false, error: 'Invalid code format' });
    }

    const Client = await pool.connect();

    try {
        await Client.query('BEGIN');

        const CodeResult = await Client.query(
            `SELECT * FROM LinkCodes WHERE Code = $1 LIMIT 1`,
            [Parsed.code]
        );

        if (CodeResult.rows.length === 0) {
            await Client.query('ROLLBACK');
            return res.json({ success: false });
        }

        const CodeRow = CodeResult.rows[0];

        if (CodeRow.platform !== Parsed.platform ||
            CodeRow.used ||
            new Date(CodeRow.expiresat) < new Date()) {
            await Client.query('ROLLBACK');
            return res.json({ success: false });
        }

        const TargetPlatform = CodeRow.platform;
        const TargetId = CodeRow.platformid;

        const SourcePlatform = 'discord';
        const SourceId = discordId;

        const ExistingA = await Client.query(
            `SELECT UserId FROM UserAccounts WHERE Platform = $1 AND PlatformId = $2`,
            [TargetPlatform, TargetId]
        );

        const ExistingB = await Client.query(
            `SELECT UserId FROM UserAccounts WHERE Platform = $1 AND PlatformId = $2`,
            [SourcePlatform, SourceId]
        );

        let UserId;

        if (ExistingA.rows.length === 0 && ExistingB.rows.length === 0) {
            const NewUser = await Client.query(
                `INSERT INTO Users DEFAULT VALUES RETURNING Id`
            );

            UserId = NewUser.rows[0].id;

            await Client.query(
                `INSERT INTO UserAccounts (UserId, Platform, PlatformId)
                 VALUES ($1, $2, $3), ($1, $4, $5)`,
                [UserId, TargetPlatform, TargetId, SourcePlatform, SourceId]
            );

        } else if (ExistingA.rows.length > 0 && ExistingB.rows.length === 0) {
            UserId = ExistingA.rows[0].userid;

            await Client.query(
                `INSERT INTO UserAccounts (UserId, Platform, PlatformId)
                 VALUES ($1, $2, $3)`,
                [UserId, SourcePlatform, SourceId]
            );

        } else if (ExistingA.rows.length === 0 && ExistingB.rows.length > 0) {
            UserId = ExistingB.rows[0].userid;

            await Client.query(
                `INSERT INTO UserAccounts (UserId, Platform, PlatformId)
                 VALUES ($1, $2, $3)`,
                [UserId, TargetPlatform, TargetId]
            );

        } else {
            if (ExistingA.rows[0].userid !== ExistingB.rows[0].userid) {
                await Client.query('ROLLBACK');
                return res.json({ success: false });
            }

            UserId = ExistingA.rows[0].userid;
        }

        await Client.query(
            `INSERT INTO AccessLogs 
     (Action, ActorPlatform, ActorId, TargetUserId, TargetPlatform, TargetPlatformId, Metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                'LINK',
                'discord',
                SourceId,
                UserId,
                TargetPlatform,
                TargetId,
                JSON.stringify({
                    code: Parsed.code
                })
            ]
        );

        await Client.query(
            `UPDATE LinkCodes SET Used = TRUE WHERE Code = $1`,
            [Parsed.code]
        );

        await Client.query(
            `INSERT INTO Entitlements (UserId, Key, Value)
             VALUES 
                ($1, 'booster', FALSE),
                ($1, 'vip', FALSE),
                ($1, 'admin', FALSE)
             ON CONFLICT (UserId, Key) DO NOTHING`,
            [UserId]
        );

        await Client.query('COMMIT');

        return res.json({ success: true });

    } catch (err) {
        await Client.query('ROLLBACK');
        console.error(err);
        return res.status(500).json({ success: false });
    } finally {
        Client.release();
    }
});

// -------------------------
// GET LINK (GENERIC)
// -------------------------
Router.post('/get-link', AuthMiddleware, async (req, res) => {
    const { platform, platformId } = req.body;

    const Result = await pool.query(
        `SELECT UserId FROM UserAccounts
         WHERE Platform = $1 AND PlatformId = $2`,
        [platform, platformId]
    );

    if (Result.rows.length === 0) {
        return res.json({ linked: false });
    }

    const UserId = Result.rows[0].userid;

    const Accounts = await pool.query(
        `SELECT Platform, PlatformId FROM UserAccounts WHERE UserId = $1`,
        [UserId]
    );

    return res.json({
        linked: true,
        accounts: Accounts.rows
    });
});

// -------------------------
// CHECK LINKED + ENTITLEMENTS
// -------------------------
Router.post('/check-linked', AuthMiddleware, async (req, res) => {
    const { platform, platformId } = req.body;

    const Result = await pool.query(
        `SELECT UserId FROM UserAccounts
         WHERE Platform = $1 AND PlatformId = $2`,
        [platform, platformId]
    );

    if (Result.rows.length === 0) {
        return res.json({ linked: false, entitlements: {} });
    }

    const UserId = Result.rows[0].userid;

    const Ent = await pool.query(
        `SELECT Key, Value FROM Entitlements WHERE UserId = $1`,
        [UserId]
    );

    const map = {};
    for (const row of Ent.rows) {
        map[row.key] = row.value;
    }

    return res.json({
        linked: true,
        entitlements: map
    });
});

// -------------------------
// REMOVE LINK (GENERIC)
// -------------------------
Router.post('/remove-link', AuthMiddleware, async (req, res) => {
    const { platform, platformId } = req.body;

    const Client = await pool.connect();

    try {
        await Client.query('BEGIN');

        const Result = await Client.query(
            `DELETE FROM UserAccounts
             WHERE Platform = $1 AND PlatformId = $2
             RETURNING UserId`,
            [platform, platformId]
        );

        if (Result.rows.length === 0) {
            await Client.query('ROLLBACK');
            return res.json({ success: false });
        }

        const UserId = Result.rows[0].userid;

        const Remaining = await Client.query(
            `SELECT COUNT(*) FROM UserAccounts WHERE UserId = $1`,
            [UserId]
        );

        if (parseInt(Remaining.rows[0].count) === 0) {
            await Client.query(`DELETE FROM Users WHERE Id = $1`, [UserId]);
        }

        await Client.query('COMMIT');

        return res.json({ success: true });

    } catch (err) {
        await Client.query('ROLLBACK');
        console.error(err);
        return res.status(500).json({ success: false });
    } finally {
        Client.release();
    }
});

// -------------------------
// GET INFO (ADMIN TOOL)
// -------------------------
Router.post('/get-info', AuthMiddleware, async (req, res) => {
    const { platform, platformId, adminId } = req.body;

    if (!platform || !platformId || !adminId) {
        return res.status(400).json({ success: false });
    }

    const Client = await pool.connect();

    try {
        await Client.query('BEGIN');

        const Result = await Client.query(
            `SELECT UserId FROM UserAccounts
             WHERE Platform = $1 AND PlatformId = $2`,
            [platform, platformId]
        );

        if (Result.rows.length === 0) {
            await Client.query('ROLLBACK');
            return res.json({ success: false });
        }

        const UserId = Result.rows[0].userid;

        const Accounts = await Client.query(
            `SELECT Platform, PlatformId FROM UserAccounts WHERE UserId = $1`,
            [UserId]
        );

        const Ent = await Client.query(
            `SELECT Key, Value FROM Entitlements WHERE UserId = $1`,
            [UserId]
        );

        const EntMap = {};
        for (const row of Ent.rows) {
            EntMap[row.key] = row.value;
        }
        await Client.query(
            `INSERT INTO AccessLogs
             (Action, ActorPlatform, ActorId, TargetUserId, Metadata)
             VALUES ($1, $2, $3, $4, $5)`,
            [
                'GET_INFO',
                'discord',
                adminId,
                UserId,
                JSON.stringify({
                    queriedPlatform: platform,
                    queriedId: platformId
                })
            ]
        );

        await Client.query('COMMIT');

        return res.json({
            success: true,
            accounts: Accounts.rows,
            entitlements: EntMap
        });

    } catch (err) {
        await Client.query('ROLLBACK');
        console.error(err);
        return res.status(500).json({ success: false });
    } finally {
        Client.release();
    }
});

module.exports = Router;