const express = require('express');
const Router = express.Router();

const { pool } = require('../db');
const AuthMiddleware = require('../middleware/auth');

// -------------------------
// GENERATE CODE
// -------------------------
Router.post('/generate-code', AuthMiddleware, async (req, res) => {
    const { steamId, code } = req.body;

    if (!steamId || !code) {
        return res.status(400).json({
            success: false,
            error: 'steamId and code are required'
        });
    }

    const Client = await pool.connect();

    try {
        const ExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await Client.query('BEGIN');

        await Client.query(
            `DELETE FROM LinkCodes WHERE SteamId = $1`,
            [steamId]
        );

        await Client.query(
            `INSERT INTO LinkCodes (Code, SteamId, ExpiresAt, Used)
             VALUES ($1, $2, $3, FALSE)`,
            [code, steamId, ExpiresAt]
        );

        await Client.query('COMMIT');

        return res.json({ success: true });
    }
    catch (Error) {
        await Client.query('ROLLBACK');
        console.error('generate-code error:', Error);

        return res.status(500).json({
            success: false,
            error: 'Database error'
        });
    }
    finally {
        Client.release();
    }
});


// -------------------------
// LINK ACCOUNT
// -------------------------
Router.post('/link', AuthMiddleware, async (req, res) => {
    const { code, discordId } = req.body;

    if (!code || !discordId) {
        return res.status(400).json({
            success: false,
            error: 'code and discordId are required'
        });
    }

    const Client = await pool.connect();

    try {
        await Client.query('BEGIN');

        // Get code
        const CodeResult = await Client.query(
            `SELECT Code, SteamId, ExpiresAt, Used
             FROM LinkCodes
             WHERE Code = $1
             LIMIT 1`,
            [code]
        );

        if (CodeResult.rows.length === 0) {
            await Client.query('ROLLBACK');
            return res.json({ success: false, error: 'Invalid code' });
        }

        const CodeRow = CodeResult.rows[0];

        if (CodeRow.used) {
            await Client.query('ROLLBACK');
            return res.json({ success: false, error: 'Code already used' });
        }

        if (new Date(CodeRow.expiresat) < new Date()) {
            await Client.query('ROLLBACK');
            return res.json({ success: false, error: 'Code expired' });
        }

        const SteamId = CodeRow.steamid;

        // Check if Steam already linked
        const ExistingSteam = await Client.query(
            `SELECT DiscordId FROM UserLinks WHERE SteamId = $1 LIMIT 1`,
            [SteamId]
        );

        if (ExistingSteam.rows.length > 0) {
            await Client.query(
                `UPDATE LinkCodes SET Used = TRUE WHERE Code = $1`,
                [code]
            );

            await Client.query('COMMIT');

            return res.json({
                success: true,
                alreadyLinked: true,
                discordId: ExistingSteam.rows[0].discordid
            });
        }

        // Check if Discord already linked
        const ExistingDiscord = await Client.query(
            `SELECT SteamId FROM UserLinks WHERE DiscordId = $1 LIMIT 1`,
            [discordId]
        );

        if (ExistingDiscord.rows.length > 0) {
            await Client.query('ROLLBACK');
            return res.json({
                success: false,
                error: 'Discord account already linked'
            });
        }

        // Insert link
        await Client.query(
            `INSERT INTO UserLinks (SteamId, DiscordId)
             VALUES ($1, $2)`,
            [SteamId, discordId]
        );

        // Mark code used
        await Client.query(
            `UPDATE LinkCodes SET Used = TRUE WHERE Code = $1`,
            [code]
        );

        // ✅ FIXED ENTITLEMENTS INSERT (key-value model)
        await Client.query(
            `INSERT INTO Entitlements (SteamId, Key, Value)
             VALUES 
                ($1, 'booster', FALSE),
                ($1, 'vip', FALSE),
                ($1, 'admin', FALSE)
             ON CONFLICT (SteamId, Key) DO NOTHING`,
            [SteamId]
        );

        await Client.query('COMMIT');

        return res.json({
            success: true,
            alreadyLinked: false
        });
    }
    catch (Error) {
        await Client.query('ROLLBACK');
        console.error('link error:', Error);

        return res.status(500).json({
            success: false,
            error: 'Database error'
        });
    }
    finally {
        Client.release();
    }
});


// -------------------------
// GET LINK
// -------------------------
Router.post('/get-link', AuthMiddleware, async (req, res) => {
    const { steamId } = req.body;

    if (!steamId) {
        return res.status(400).json({
            success: false,
            error: 'steamId is required'
        });
    }

    try {
        const Result = await pool.query(
            `SELECT SteamId, DiscordId, LinkedAt
             FROM UserLinks
             WHERE SteamId = $1
             LIMIT 1`,
            [steamId]
        );

        if (Result.rows.length === 0) {
            return res.json({
                success: true,
                linked: false
            });
        }

        const Row = Result.rows[0];

        return res.json({
            success: true,
            linked: true,
            steamId: Row.steamid.toString(),
            discordId: Row.discordid.toString(),
            linkedAt: Row.linkedat
        });
    }
    catch (Error) {
        console.error('get-link error:', Error);

        return res.status(500).json({
            success: false,
            error: 'Database error'
        });
    }
});


// -------------------------
// CHECK LINKED + ENTITLEMENTS
// -------------------------
Router.post('/check-linked', AuthMiddleware, async (req, res) => {
    const { steamId } = req.body;

    if (!steamId) {
        return res.status(400).json({
            success: false,
            error: 'steamId is required'
        });
    }

    try {
        const LinkResult = await pool.query(
            `SELECT DiscordId FROM UserLinks WHERE SteamId = $1 LIMIT 1`,
            [steamId]
        );

        if (LinkResult.rows.length === 0) {
            return res.json({
                linked: false,
                entitlements: {
                    Booster: false,
                    Vip: false,
                    Admin: false
                }
            });
        }

        const EntitlementResult = await pool.query(
            `SELECT Key, Value FROM Entitlements WHERE SteamId = $1`,
            [steamId]
        );

        const entMap = {
            Booster: false,
            Vip: false,
            Admin: false
        };

        for (const row of EntitlementResult.rows) {
            const key = row.key.toLowerCase();

            if (key === 'booster') entMap.Booster = row.value;
            if (key === 'vip') entMap.Vip = row.value;
            if (key === 'admin') entMap.Admin = row.value;
        }
        const discordId = LinkResult.rows[0]?.discordid ?? "Error";

        return res.json({
            linked: true,
            discordId,
            entitlements: entMap
        });
    }
    catch (Error) {
        console.error('check-linked error:', Error);

        return res.status(500).json({
            linked: false,
            entitlements: {
                Booster: false,
                Vip: false,
                Admin: false
            }
        });
    }
});

// -------------------------
// REMOVE LINK
// -------------------------
Router.post('/remove-link', AuthMiddleware, async (req, res) => {
    const { steamId, discordId } = req.body;

    if (!steamId && !discordId) {
        return res.status(400).json({
            success: false,
            error: 'steamId or discordId is required'
        });
    }

    const Client = await pool.connect();

    try {
        await Client.query('BEGIN');

        let Result;

        if (steamId) {
            Result = await Client.query(
                `DELETE FROM UserLinks
                 WHERE SteamId = $1
                 RETURNING SteamId, DiscordId`,
                [steamId]
            );
        } else {
            Result = await Client.query(
                `DELETE FROM UserLinks
                 WHERE DiscordId = $1
                 RETURNING SteamId, DiscordId`,
                [discordId]
            );
        }

        if (Result.rows.length === 0) {
            await Client.query('ROLLBACK');
            return res.json({
                success: false,
                error: 'No link found'
            });
        }

        const Row = Result.rows[0];

        // Optional: also wipe entitlements
        await Client.query(
            `DELETE FROM Entitlements WHERE SteamId = $1`,
            [Row.steamid]
        );

        await Client.query('COMMIT');

        return res.json({
            success: true,
            steamId: Row.steamid.toString(),
            discordId: Row.discordid.toString()
        });
    }
    catch (Error) {
        await Client.query('ROLLBACK');
        console.error('remove-link error:', Error);

        return res.status(500).json({
            success: false,
            error: 'Database error'
        });
    }
    finally {
        Client.release();
    }
});

module.exports = Router;