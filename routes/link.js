const express = require('express');
const Router = express.Router();

const PoolInstance = require('../db');
const AuthMiddleware = require('../middleware/auth');

Router.post('/generate-code', AuthMiddleware, async (req, res) => {
    const { steamId, code } = req.body;

    if (!steamId || !code) {
        return res.status(400).json({
            success: false,
            error: 'steamId and code are required'
        });
    }

    const Client = await PoolInstance.connect();

    try {
        const ExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await Client.query('BEGIN');

        await Client.query(
            `
            DELETE FROM LinkCodes
            WHERE SteamId = $1
            `,
            [steamId]
        );

        await Client.query(
            `
            INSERT INTO LinkCodes (Code, SteamId, ExpiresAt, Used)
            VALUES ($1, $2, $3, FALSE)
            `,
            [code, steamId, ExpiresAt]
        );

        await Client.query('COMMIT');

        return res.json({
            success: true
        });
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

Router.post('/link', AuthMiddleware, async (req, res) => {
    const { code, discordId } = req.body;

    if (!code || !discordId) {
        return res.status(400).json({
            success: false,
            error: 'code and discordId are required'
        });
    }

    const Client = await PoolInstance.connect();

    try {
        await Client.query('BEGIN');

        const CodeResult = await Client.query(
            `
            SELECT Code, SteamId, ExpiresAt, Used
            FROM LinkCodes
            WHERE Code = $1
            LIMIT 1
            `,
            [code]
        );

        if (CodeResult.rows.length === 0) {
            await Client.query('ROLLBACK');
            return res.json({
                success: false,
                error: 'Invalid code'
            });
        }

        const CodeRow = CodeResult.rows[0];

        if (CodeRow.used) {
            await Client.query('ROLLBACK');
            return res.json({
                success: false,
                error: 'Code already used'
            });
        }

        if (new Date(CodeRow.expiresat) < new Date()) {
            await Client.query('ROLLBACK');
            return res.json({
                success: false,
                error: 'Code expired'
            });
        }

        const SteamId = CodeRow.steamid;

        const ExistingSteamLinkResult = await Client.query(
            `
            SELECT SteamId, DiscordId
            FROM UserLinks
            WHERE SteamId = $1
            LIMIT 1
            `,
            [SteamId]
        );

        if (ExistingSteamLinkResult.rows.length > 0) {
            const ExistingDiscordId = ExistingSteamLinkResult.rows[0].discordid;

            await Client.query(
                `
                UPDATE LinkCodes
                SET Used = TRUE
                WHERE Code = $1
                `,
                [code]
            );

            await Client.query('COMMIT');

            return res.json({
                success: true,
                alreadyLinked: true,
                discordId: ExistingDiscordId
            });
        }

        const ExistingDiscordLinkResult = await Client.query(
            `
            SELECT SteamId, DiscordId
            FROM UserLinks
            WHERE DiscordId = $1
            LIMIT 1
            `,
            [discordId]
        );

        if (ExistingDiscordLinkResult.rows.length > 0) {
            await Client.query('ROLLBACK');
            return res.json({
                success: false,
                error: 'Discord account already linked'
            });
        }

        await Client.query(
            `
            INSERT INTO UserLinks (SteamId, DiscordId)
            VALUES ($1, $2)
            `,
            [SteamId, discordId]
        );

        await Client.query(
            `
            UPDATE LinkCodes
            SET Used = TRUE
            WHERE Code = $1
            `,
            [code]
        );

        await Client.query(
            `
            INSERT INTO Entitlements (SteamId, Booster, Vip, Admin, LastUpdated)
            VALUES ($1, FALSE, FALSE, FALSE, NOW())
            ON CONFLICT (SteamId) DO NOTHING
            `,
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

Router.post('/get-link', AuthMiddleware, async (req, res) => {
    const { steamId } = req.body;

    if (!steamId) {
        return res.status(400).json({
            success: false,
            error: 'steamId is required'
        });
    }

    try {
        const Result = await PoolInstance.query(
            `
            SELECT SteamId, DiscordId, LinkedAt
            FROM UserLinks
            WHERE SteamId = $1
            LIMIT 1
            `,
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

Router.post('/check-is-linked', AuthMiddleware, async (req, res) => {
    const { steamId } = req.body;

    if (!steamId) {
        return res.status(400).json({
            success: false,
            error: 'steamId is required'
        });
    }

    try {
        const LinkResult = await PoolInstance.query(
            `
            SELECT SteamId, DiscordId
            FROM UserLinks
            WHERE SteamId = $1
            LIMIT 1
            `,
            [steamId]
        );

        if (LinkResult.rows.length === 0) {
            return res.json({
                success: true,
                linked: false,
                entitlements: {
                    booster: false,
                    vip: false,
                    admin: false
                }
            });
        }

        const EntitlementResult = await PoolInstance.query(
            `
            SELECT Booster, Vip, Admin
            FROM Entitlements
            WHERE SteamId = $1
            LIMIT 1
            `,
            [steamId]
        );

        const EntitlementRow = EntitlementResult.rows[0];

        return res.json({
            success: true,
            linked: true,
            discordId: LinkResult.rows[0].discordid.toString(),
            entitlements: {
                booster: EntitlementRow ? EntitlementRow.booster : false,
                vip: EntitlementRow ? EntitlementRow.vip : false,
                admin: EntitlementRow ? EntitlementRow.admin : false
            }
        });
    }
    catch (Error) {
        console.error('check-is-linked error:', Error);

        return res.status(500).json({
            success: false,
            error: 'Database error'
        });
    }
});

Router.post('/check-linked', AuthMiddleware, async (req, res) => {
    const { steamId } = req.body;

    if (!steamId) {
        return res.status(400).json({
            success: false,
            error: 'steamId is required'
        });
    }

    try {
        const LinkResult = await PoolInstance.query(
            `
            SELECT SteamId, DiscordId
            FROM UserLinks
            WHERE SteamId = $1
            LIMIT 1
            `,
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

        const EntitlementResult = await PoolInstance.query(
            `
            SELECT Booster, Vip, Admin
            FROM Entitlements
            WHERE SteamId = $1
            LIMIT 1
            `,
            [steamId]
        );

        const EntitlementRow = EntitlementResult.rows[0];

        return res.json({
            linked: true,
            entitlements: {
                Booster: EntitlementRow ? EntitlementRow.booster : false,
                Vip: EntitlementRow ? EntitlementRow.vip : false,
                Admin: EntitlementRow ? EntitlementRow.admin : false
            }
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

module.exports = Router;