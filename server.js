// CleanSweep Backend (server.js)
// --- Dependencies ---
const express = require('express');
const { Pool } = require('pg'); // Use pg for PostgreSQL
const cors = require('cors');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { Readable } = require('stream');
const fetch = require('node-fetch-cjs'); // Use node-fetch-cjs for CommonJS compatibility
require('dotenv').config(); // For environment variables

// --- App & Middleware Setup ---
const app = express();
const port = process.env.PORT || 3000;

app.use(cors()); // Allow cross-origin requests
app.use(express.json()); // Parse JSON bodies

// --- Cloudinary Setup (for Image Uploads) ---
// We use 'memoryStorage' to hold the file in a buffer before uploading to Cloudinary
const upload = multer({ storage: multer.memoryStorage() });
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Uploads a buffer to Cloudinary
 * @param {Buffer} buffer - The image buffer from multer
 * @returns {Promise<string>} - The secure URL of the uploaded image
 */
const uploadToCloudinary = (buffer) => {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { resource_type: 'image' },
            (error, result) => {
                if (error) {
                    return reject(new Error('Cloudinary upload failed: ' + error.message));
                }
                resolve(result.secure_url);
            }
        );
        Readable.from(buffer).pipe(stream);
    });
};

// --- PostgreSQL Database Connection ---
let dbPool;
async function initDatabase() {
    try {
        // Render provides a DATABASE_URL environment variable, which the Pool uses automatically.
        dbPool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: {
                rejectUnauthorized: false // Required for Render connections
            }
        });
        // Test connection
        await dbPool.query('SELECT 1');
        console.log('PostgreSQL Database connected successfully.');
    } catch (error) {
        console.error('Failed to connect to PostgreSQL database:', error);
        process.exit(1); // Exit if DB connection fails
    }
}

// --- Gemini AI Helper Function ---

/**
 * Calls Gemini API for AI Triage
 * @param {Buffer} imageBuffer - The image buffer
 * @param {string} mimeType - The image mime type (e.g., 'image/jpeg')
 * @param {string} geminiKey - The API key from the user
 * @returns {Promise<object>} - { category, severity }
 */
async function getAITriage(imageBuffer, mimeType, geminiKey) {
    if (!geminiKey) {
        console.warn('No Gemini key provided. Skipping AI triage.');
        return { category: 'Other', severity: 'Medium' };
    }

    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${geminiKey}`;
    
    const imageBase64 = imageBuffer.toString('base64');
    
    const prompt = `
        Analyze this image of a dump site.
        Respond ONLY with a valid JSON object with two keys: "category" and "severity".
        
        "category" options: "Household Waste", "Construction Debris", "Hazardous/Chemical", "E-Waste", "Organic/Green Waste", "Other".
        "severity" options: "Small" (e.g., a few bags), "Medium" (e.g., a small pile, mattress), "Large" (e.g., truckload, construction site).
        
        Example response:
        {"category": "Construction Debris", "severity": "Large"}
    `;

    const payload = {
        contents: [
            {
                role: "user",
                parts: [
                    { text: prompt },
                    { inlineData: { mimeType: mimeType, data: imageBase64 } }
                ]
            }
        ],
    };

    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error('Gemini API Error:', errorData.error.message);
            throw new Error('Gemini API request failed');
        }

        const result = await response.json();
        const text = result.candidates[0].content.parts[0].text;
        
        // Clean up the text in case Gemini returns markdown JSON
        const jsonText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const aiResponse = JSON.parse(jsonText);
        
        return {
            category: aiResponse.category || 'Other',
            severity: aiResponse.severity || 'Medium'
        };

    } catch (error) {
        console.error('AI Triage Failed:', error.message);
        // Fallback on error
        return { category: 'Other', severity: 'Medium' };
    }
}


// --- API ENDPOINTS ---

/**
 * Endpoint: POST /api/report
 * Creates a new report or upvotes an existing one.
 */
app.post('/api/report', upload.single('photo'), async (req, res) => {
    try {
        const { lat, lng, description, citizen_device_id } = req.body;
        const photoBuffer = req.file.buffer;
        const mimeType = req.file.mimetype;
        const geminiKey = req.headers['x-gemini-key'];

        if (!lat || !lng || !citizen_device_id || !photoBuffer) {
            return res.status(400).json({ error: 'Missing required fields.' });
        }

        // --- 1. Clustering Logic ---
        // Haversine formula in SQL to find nearby pending reports (within 50 meters)
        // Placeholders changed from ? to $1, $2, etc. for PostgreSQL
        const { rows: existing } = await dbPool.query(
            `SELECT id, (
                6371 * acos(
                    cos(radians($1)) * cos(radians(lat)) *
                    cos(radians(lng) - radians($2)) +
                    sin(radians($3)) * sin(radians(lat))
                )
            ) AS distance
            FROM reports
            WHERE status = 'pending'
            HAVING distance < 0.05
            ORDER BY distance
            LIMIT 1`,
            [lat, lng, lat]
        );

        if (existing.length > 0) {
            // Found a duplicate! Upvote it.
            const reportId = existing[0].id;
            await dbPool.query(
                'UPDATE reports SET upvotes = upvotes + 1 WHERE id = $1',
                [reportId]
            );
            const { rows: updatedReport } = await dbPool.query('SELECT * FROM reports WHERE id = $1', [reportId]);
            return res.status(200).json({ ...updatedReport[0], upvoted: true });
        }

        // --- 2. Not a duplicate, create new report ---
        
        // Upload photo to Cloudinary
        const initial_photo_url = await uploadToCloudinary(photoBuffer);
        
        // Get AI Triage
        const { category, severity } = await getAITriage(photoBuffer, mimeType, geminiKey);
        
        // Save to database
        // Added "RETURNING *" to get the new row back (PostgreSQL specific)
        const { rows } = await dbPool.query(
            `INSERT INTO reports (citizen_device_id, lat, lng, initial_photo_url, description, category, severity)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [citizen_device_id, lat, lng, initial_photo_url, description, category, severity]
        );
        
        const newReport = rows[0];
        
        res.status(201).json(newReport);

    } catch (error) {
        console.error('POST /api/report Error:', error);
        res.status(500).json({ error: 'Server error while creating report.' });
    }
});

/**
 * Endpoint: GET /api/reports
 * Gets all reports for the admin dashboard.
 */
app.get('/api/reports', async (req, res) => {
    try {
        const { rows: reports } = await dbPool.query('SELECT * FROM reports ORDER BY created_at DESC');
        res.json(reports);
    } catch (error) {
        console.error('GET /api/reports Error:', error);
        res.status(500).json({ error: 'Server error while fetching reports.' });
    }
});

/**
 * Endpoint: GET /api/reports/citizen/:deviceId
 * Gets all reports for a specific citizen.
 */
app.get('/api/reports/citizen/:deviceId', async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { rows: reports } = await dbPool.query(
            'SELECT * FROM reports WHERE citizen_device_id = $1 ORDER BY created_at DESC',
            [deviceId]
        );
        res.json(reports);
    } catch (error) {
        console.error('GET /api/reports/citizen Error:', error);
        res.status(500).json({ error: 'Server error while fetching citizen reports.' });
    }
});

/**
 * Endpoint: PUT /api/report/:id/status
 * Updates the status of a report (e.g., to 'in_progress').
 */
app.put('/api/report/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!status || !['pending', 'in_progress', 'cleaned'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status.' });
        }
        
        await dbPool.query('UPDATE reports SET status = $1 WHERE id = $2', [status, id]);
        res.json({ success: true, message: 'Status updated.' });

    } catch (error) {
        console.error('PUT /api/report/status Error:', error);
        res.status(500).json({ error: 'Server error while updating status.' });
    }
});

/**
 * Endpoint: PUT /api/report/:id/cleanup
 * Marks a report as 'cleaned' and uploads proof-of-cleanup photo.
 */
app.put('/api/report/:id/cleanup', upload.single('photo'), async (req, res) => {
    try {
        const { id } = req.params;
        const photoBuffer = req.file.buffer;

        if (!photoBuffer) {
            return res.status(400).json({ error: 'Cleanup photo is required.' });
        }

        // Upload cleanup photo
        const cleanup_photo_url = await uploadToCloudinary(photoBuffer);

        // Update database
        await dbPool.query(
            'UPDATE reports SET status = $1, cleanup_photo_url = $2, cleaned_at = NOW() WHERE id = $3',
            ['cleaned', cleanup_photo_url, id]
        );
        
        res.json({ success: true, message: 'Report marked as cleaned.' });
        
    } catch (error) {
        console.error('PUT /api/report/cleanup Error:', error);
        res.status(500).json({ error: 'Server error while processing cleanup.' });
    }
});

/**
 * Endpoint: GET /api/stats
 * Gathers all statistics for the analytics dashboard.
 */
app.get('/api/stats', async (req, res) => {
    try {
        // 1. KPIs
        // Changed TIMESTAMPDIFF to PostgreSQL's EXTRACT(EPOCH FROM ...) / 3600
        const { rows: kpiRows } = await dbPool.query(
            `SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status = 'cleaned' THEN 1 ELSE 0 END) as cleaned,
                AVG(CASE WHEN status = 'cleaned' THEN EXTRACT(EPOCH FROM (cleaned_at - created_at)) / 3600 ELSE NULL END) as avg_cleanup_time_hours
            FROM reports`
        );
        const kpis = kpiRows[0];
        
        // 2. Reports over Time (last 30 days)
        // Changed CURDATE() and INTERVAL syntax for PostgreSQL
        const { rows: overTimeRows } = await dbPool.query(
            `SELECT DATE(created_at) as date, COUNT(*) as count
             FROM reports
             WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
             GROUP BY DATE(created_at)
             ORDER BY date ASC`
        );
        
        // 3. Reports by Category
        const { rows: byCategoryRows } = await dbPool.query(
            `SELECT category, COUNT(*) as count
             FROM reports
             GROUP BY category`
        );
        
        // 4. Location Hotspots
        const { rows: locationRows } = await dbPool.query(
            `SELECT lat, lng FROM reports`
        );

        res.json({
            kpis: {
                ...kpis,
                avg_cleanup_time_hours: kpis.avg_cleanup_time_hours ? parseFloat(kpis.avg_cleanup_time_hours).toFixed(1) : 0
            },
            overTime: overTimeRows,
            byCategory: byCategoryRows,
            locations: locationRows
        });
        
    } catch (error) {
        console.error('GET /api/stats Error:', error);
        res.status(500).json({ error: 'Server error while fetching stats.' });
    }
});


// --- Start Server ---
app.listen(port, async () => {
    await initDatabase();
    console.log(`CleanSweep server listening on port ${port}`);
});

