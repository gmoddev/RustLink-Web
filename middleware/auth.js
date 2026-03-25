require('dotenv').config();

function AuthMiddleware(req, res, next) {
    const AuthorizationHeader = req.headers.authorization;

    if (!AuthorizationHeader) {
        return res.status(401).json({
            success: false,
            error: 'Missing authorization header'
        });
    }

    if (AuthorizationHeader !== `Bearer ${process.env.API_KEY}`) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized'
        });
    }

    next();
}

module.exports = AuthMiddleware;