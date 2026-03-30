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

function GenerateCode(Prefix) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';

    for (let i = 0; i < 6; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }

    return `${Prefix}-${result}`;
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
// GENERATE ROBLOX CODE
// -------------------------
Router.post('/rbx-code', AuthMiddleware, async (req, res) => {
    const { platformId } = req.body;

    if (!platformId) {
        return res.status(400).json({ success: false });
    }

    const Client = await pool.connect();

    try {
        const FullCode = GenerateCode('rbx');
        const Parsed = ParseCode(FullCode);

        await Client.query('BEGIN');

        await CreateLinkCode(Client, 'roblox', platformId, Parsed.code);

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
// GENERATE STEAM CODE
// -------------------------
Router.post('/stm-code', AuthMiddleware, async (req, res) => {
    const { platformId } = req.body;

    if (!platformId) {
        return res.status(400).json({ success: false });
    }

    const Client = await pool.connect();

    try {
        const FullCode = GenerateCode('stm');
        const Parsed = ParseCode(FullCode);

        await Client.query('BEGIN');

        await CreateLinkCode(Client, 'steam', platformId, Parsed.code);

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
// LINK ACCOUNT
// -------------------------
Router.post('/link', AuthMiddleware, async (req, res) => {
    const { platform, platformId } = req.body;
    const rawCode = req.body.code?.toString();

    if (!platform || !platformId || !rawCode) {
        return res.status(400).json({
            success: false,
            error: 'platform, platformId, and code are required'
        });
    }

    const Parsed = ParseCode(rawCode);

    if (!Parsed) {
        return res.json({
            success: false,
            error: 'Invalid code format'
        });
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
            return res.json({ success: false, error: 'Invalid code' });
        }

        const CodeRow = CodeResult.rows[0];

        // Ensure prefix matches DB platform
        if (CodeRow.platform !== Parsed.platform) {
            await Client.query('ROLLBACK');
            return res.json({ success: false, error: 'Code mismatch' });
        }

        if (CodeRow.used) {
            await Client.query('ROLLBACK');
            return res.json({ success: false, error: 'Code already used' });
        }

        if (new Date(CodeRow.expiresat) < new Date()) {
            await Client.query('ROLLBACK');
            return res.json({ success: false, error: 'Code expired' });
        }

        const TargetPlatform = CodeRow.platform;
        const TargetId = CodeRow.platformid;

        // Check existing users
        const ExistingA = await Client.query(
            `SELECT UserId FROM UserAccounts WHERE Platform = $1 AND PlatformId = $2`,
            [TargetPlatform, TargetId]
        );

        const ExistingB = await Client.query(
            `SELECT UserId FROM UserAccounts WHERE Platform = $1 AND PlatformId = $2`,
            [platform, platformId]
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
                [UserId, TargetPlatform, TargetId, platform, platformId]
            );

        } else if (ExistingA.rows.length > 0 && ExistingB.rows.length === 0) {
            UserId = ExistingA.rows[0].userid;

            await Client.query(
                `INSERT INTO UserAccounts (UserId, Platform, PlatformId)
                 VALUES ($1, $2, $3)`,
                [UserId, platform, platformId]
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
                return res.json({
                    success: false,
                    error: 'Accounts already linked to different users'
                });
            }

            UserId = ExistingA.rows[0].userid;
        }

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
// GET LINKED ACCOUNTS
// -------------------------
Router.post('/get-link', AuthMiddleware, async (req, res) => {
    const { platform, platformId } = req.body;

    try {
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

    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false });
    }
});


// -------------------------
// CHECK LINKED + ENTITLEMENTS
// -------------------------
Router.post('/check-linked', AuthMiddleware, async (req, res) => {
    const { platform, platformId } = req.body;

    try {
        const Result = await pool.query(
            `SELECT UserId FROM UserAccounts
             WHERE Platform = $1 AND PlatformId = $2`,
            [platform, platformId]
        );

        if (Result.rows.length === 0) {
            return res.json({
                linked: false,
                entitlements: {}
            });
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

    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false });
    }
});


// -------------------------
// REMOVE LINK
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

module.exports = Router;