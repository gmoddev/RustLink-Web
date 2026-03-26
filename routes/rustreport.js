const express = require('express');
const Router = express.Router();

const { pool } = require('../db');
const AuthMiddleware = require('../middleware/auth');

// ============================================================
//  POST /server/startup
//  Called once when the game server boots.
// ============================================================
Router.post('/startup', AuthMiddleware, async (req, res) => {
    const {
        serverId, serverName, ip, port,
        mapName, mapSize, mapSeed, levelUrl,
        maxPlayers, gameVersion, oxideVersion,
        description, pve, tags, reportedAt
    } = req.body;

    if (!serverId || !serverName || !ip || !port) {
        return res.status(400).json({
            success: false,
            error: 'serverId, serverName, ip, and port are required'
        });
    }

    const Client = await pool.connect();

    try {
        await Client.query('BEGIN');

        // Upsert the server row so re-boots update its metadata
        await Client.query(
            `
            INSERT INTO servers (id, name, ip, port, description, pve, tags, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            ON CONFLICT (id) DO UPDATE SET
                name        = EXCLUDED.name,
                ip          = EXCLUDED.ip,
                port        = EXCLUDED.port,
                description = EXCLUDED.description,
                pve         = EXCLUDED.pve,
                tags        = EXCLUDED.tags,
                updated_at  = NOW()
            `,
            [serverId, serverName, ip, port, description ?? null, pve ?? false, tags ?? []]
        );

        // Write a new snapshot for this boot
        const SnapshotResult = await Client.query(
            `
            INSERT INTO server_snapshots
                (server_id, map_name, map_size, map_seed, level_url, max_players, game_version, oxide_version, reported_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TO_TIMESTAMP($9))
            RETURNING id
            `,
            [
                serverId, mapName ?? null, mapSize ?? null, mapSeed ?? null,
                levelUrl ?? null, maxPlayers ?? null, gameVersion ?? null,
                oxideVersion ?? null, reportedAt ?? Math.floor(Date.now() / 1000)
            ]
        );

        await Client.query('COMMIT');

        return res.json({ success: true, snapshotId: SnapshotResult.rows[0].id });
    }
    catch (Error) {
        await Client.query('ROLLBACK');
        console.error('server/startup error:', Error);
        return res.status(500).json({ success: false, error: 'Database error' });
    }
    finally {
        Client.release();
    }
});

// ============================================================
//  POST /server/request-map
//  Fetches a map image from rustmaps.com and caches the URL.
// ============================================================
Router.post('/request-map', AuthMiddleware, async (req, res) => {
    const { serverId, seed, size, staging } = req.body;

    if (!serverId || !seed || !size) {
        return res.status(400).json({
            success: false,
            error: 'serverId, seed, and size are required'
        });
    }

    try {
        // Check if we already have a cached image for this seed+size
        const Existing = await pool.query(
            `SELECT image_url FROM map_images WHERE server_id = $1 AND map_seed = $2 AND map_size = $3 LIMIT 1`,
            [serverId, seed, size]
        );

        if (Existing.rows.length > 0) {
            return res.json({ success: true, imageUrl: Existing.rows[0].image_url, cached: true });
        }

        // Fetch from rustmaps.com
        const Branch = staging ? 'staging' : 'main';
        const MapUrl = `https://rustmaps.com/api/v2/maps/${seed}/${size}?staging=${staging ? 1 : 0}`;

        const MapRes = await fetch(MapUrl, {
            headers: { 'X-API-Key': process.env.RUSTMAPS_API_KEY }
        });

        if (!MapRes.ok) {
            return res.status(502).json({ success: false, error: 'Failed to fetch map from rustmaps.com' });
        }

        const MapData = await MapRes.json();
        const ImageUrl = MapData?.imageUrl ?? MapData?.url ?? null;

        if (!ImageUrl) {
            return res.status(502).json({ success: false, error: 'No image URL in rustmaps response' });
        }

        // Cache it
        await pool.query(
            `
            INSERT INTO map_images (server_id, map_seed, map_size, image_url)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (server_id, map_seed, map_size) DO UPDATE SET
                image_url  = EXCLUDED.image_url,
                fetched_at = NOW()
            `,
            [serverId, seed, size, ImageUrl]
        );

        return res.json({ success: true, imageUrl: ImageUrl, cached: false });
    }
    catch (Error) {
        console.error('server/request-map error:', Error);
        return res.status(500).json({ success: false, error: 'Server error' });
    }
});

// ============================================================
//  POST /server/heartbeat
//  Called every N seconds while the server is alive.
// ============================================================
Router.post('/heartbeat', AuthMiddleware, async (req, res) => {
    const { serverId, playerCount, maxPlayers, sleepingCount, fps, entityCount, reportedAt } = req.body;

    if (!serverId) {
        return res.status(400).json({ success: false, error: 'serverId is required' });
    }

    try {
        await pool.query(
            `
            INSERT INTO heartbeats (server_id, player_count, max_players, sleeping_count, fps, entity_count, reported_at)
            VALUES ($1, $2, $3, $4, $5, $6, TO_TIMESTAMP($7))
            `,
            [
                serverId,
                playerCount   ?? 0,
                maxPlayers    ?? 0,
                sleepingCount ?? 0,
                fps           ?? 0,
                entityCount   ?? 0,
                reportedAt    ?? Math.floor(Date.now() / 1000)
            ]
        );

        return res.json({ success: true });
    }
    catch (Error) {
        console.error('server/heartbeat error:', Error);
        return res.status(500).json({ success: false, error: 'Database error' });
    }
});

// ============================================================
//  POST /server/player-join
//  Called when a player connects to the server.
// ============================================================
Router.post('/player-join', AuthMiddleware, async (req, res) => {
    const { serverId, player } = req.body;

    if (!serverId || !player?.steamId) {
        return res.status(400).json({ success: false, error: 'serverId and player.steamId are required' });
    }

    const Client = await pool.connect();

    try {
        await Client.query('BEGIN');

        // Upsert player record
        await Client.query(
            `
            INSERT INTO players (steam_id, display_name, last_seen_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (steam_id) DO UPDATE SET
                display_name = EXCLUDED.display_name,
                last_seen_at = NOW()
            `,
            [player.steamId, player.displayName ?? 'Unknown']
        );

        // Open a new session
        await Client.query(
            `
            INSERT INTO player_sessions (server_id, steam_id, ip_address, joined_at)
            VALUES ($1, $2, $3::inet, TO_TIMESTAMP($4))
            `,
            [
                serverId,
                player.steamId,
                player.ipAddress ?? null,
                player.joinedAt ?? Math.floor(Date.now() / 1000)
            ]
        );

        await Client.query('COMMIT');

        return res.json({ success: true });
    }
    catch (Error) {
        await Client.query('ROLLBACK');
        console.error('server/player-join error:', Error);
        return res.status(500).json({ success: false, error: 'Database error' });
    }
    finally {
        Client.release();
    }
});

// ============================================================
//  POST /server/player-leave
//  Called when a player disconnects from the server.
// ============================================================
Router.post('/player-leave', AuthMiddleware, async (req, res) => {
    const { serverId, steamId, reason, leftAt } = req.body;

    if (!serverId || !steamId) {
        return res.status(400).json({ success: false, error: 'serverId and steamId are required' });
    }

    try {
        // Close the most recent open session for this player on this server
        await pool.query(
            `
            UPDATE player_sessions
            SET
                left_at           = TO_TIMESTAMP($1),
                disconnect_reason = $2
            WHERE id = (
                SELECT id FROM player_sessions
                WHERE server_id = $3
                  AND steam_id  = $4
                  AND left_at IS NULL
                ORDER BY joined_at DESC
                LIMIT 1
            )
            `,
            [
                leftAt ?? Math.floor(Date.now() / 1000),
                reason ?? 'unknown',
                serverId,
                steamId
            ]
        );

        return res.json({ success: true });
    }
    catch (Error) {
        console.error('server/player-leave error:', Error);
        return res.status(500).json({ success: false, error: 'Database error' });
    }
});

// ============================================================
//  GET /server/:id/status
//  Returns latest heartbeat + current snapshot for a server.
// ============================================================
Router.get('/:id/status', AuthMiddleware, async (req, res) => {
    const { id } = req.params;

    try {
        const [StatusResult, SnapshotResult, MapResult] = await Promise.all([
            pool.query(`SELECT * FROM v_server_status WHERE server_id = $1`, [id]),
            pool.query(
                `SELECT * FROM server_snapshots WHERE server_id = $1 ORDER BY reported_at DESC LIMIT 1`,
                [id]
            ),
            pool.query(
                `SELECT image_url FROM map_images WHERE server_id = $1 ORDER BY fetched_at DESC LIMIT 1`,
                [id]
            )
        ]);

        if (StatusResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Server not found' });
        }

        return res.json({
            success:  true,
            status:   StatusResult.rows[0],
            snapshot: SnapshotResult.rows[0] ?? null,
            mapImage: MapResult.rows[0]?.image_url ?? null
        });
    }
    catch (Error) {
        console.error('server/:id/status error:', Error);
        return res.status(500).json({ success: false, error: 'Database error' });
    }
});

// ============================================================
//  GET /server/:id/players
//  Returns all players currently online (no left_at).
// ============================================================
Router.get('/:id/players', AuthMiddleware, async (req, res) => {
    const { id } = req.params;

    try {
        const Result = await pool.query(
            `
            SELECT
                p.steam_id,
                p.display_name,
                p.country_code,
                s.joined_at
            FROM player_sessions s
            JOIN players p ON p.steam_id = s.steam_id
            WHERE s.server_id = $1
              AND s.left_at IS NULL
            ORDER BY s.joined_at ASC
            `,
            [id]
        );

        return res.json({ success: true, players: Result.rows });
    }
    catch (Error) {
        console.error('server/:id/players error:', Error);
        return res.status(500).json({ success: false, error: 'Database error' });
    }
});

// ============================================================
//  GET /server/:id/history
//  Returns heartbeat history for player count graphs.
//  Optional query params: ?hours=24 (default 24)
// ============================================================
Router.get('/:id/history', AuthMiddleware, async (req, res) => {
    const { id } = req.params;
    const Hours = Math.min(parseInt(req.query.hours ?? '24', 10), 168); // cap at 7 days

    try {
        const Result = await pool.query(
            `
            SELECT
                player_count,
                sleeping_count,
                fps,
                entity_count,
                reported_at
            FROM heartbeats
            WHERE server_id  = $1
              AND reported_at > NOW() - ($2 || ' hours')::INTERVAL
            ORDER BY reported_at ASC
            `,
            [id, Hours]
        );

        return res.json({ success: true, history: Result.rows });
    }
    catch (Error) {
        console.error('server/:id/history error:', Error);
        return res.status(500).json({ success: false, error: 'Database error' });
    }
});

module.exports = Router;
