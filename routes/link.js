const express = require('express');
const Router = express.Router();

const { pool } = require('../db');
const AuthMiddleware = require('../middleware/auth');


// -------------------------
// GENERATE CODE
// -------------------------
Router.post('/generate-code', AuthMiddleware, async (req, res) => {
    const { platform, platformId, code } = req.body;

    if (!platform || !platformId || !code) {
        return res.status(400).json({
            success: false,
            error: 'platform, platformId, and code are required'
        });
    }

    const Client = await pool.connect();

    try {
        const ExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await Client.query('BEGIN');

        await Client.query(
            `DELETE FROM LinkCodes WHERE Platform = $1 AND PlatformId = $2`,
            [platform, platformId]
        );

        await Client.query(
            `INSERT INTO LinkCodes (Code, Platform, PlatformId, ExpiresAt, Used)
             VALUES ($1, $2, $3, $4, FALSE)`,
            [code, platform, platformId, ExpiresAt]
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
// LINK ACCOUNT
// -------------------------
Router.post('/link', AuthMiddleware, async (req, res) => {
    const { platform, platformId } = req.body;
    const code = req.body.code?.toString().toUpperCase().trim();

    if (!platform || !platformId || !code) {
        return res.status(400).json({
            success: false,
            error: 'platform, platformId, and code are required'
        });
    }

    const Client = await pool.connect();

    try {
        await Client.query('BEGIN');

        const CodeResult = await Client.query(
            `SELECT * FROM LinkCodes WHERE Code = $1 LIMIT 1`,
            [code]
        );

        if (CodeResult.rows.length === 0) {
            await Client.query('ROLLBACK');
            return res.json({ success: false, error: 'Invalid code' });
        }

        const CodeRow = CodeResult.rows[0];

        if (CodeRow.used) {
            await Client.query('ROLLBACK');
            return res.json({ success: false, error: 'Code used' });
        }

        if (new Date(CodeRow.expiresat) < new Date()) {
            await Client.query('ROLLBACK');
            return res.json({ success: false, error: 'Expired' });
        }

        const TargetPlatform = CodeRow.platform;
        const TargetId = CodeRow.platformid;

        // Find existing users
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
            // Create new user
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

        // Mark code used
        await Client.query(
            `UPDATE LinkCodes SET Used = TRUE WHERE Code = $1`,
            [code]
        );

        // Ensure entitlements exist
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

    if (!platform || !platformId) {
        return res.status(400).json({ success: false });
    }

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
            await Client.query(
                `DELETE FROM Users WHERE Id = $1`,
                [UserId]
            );
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