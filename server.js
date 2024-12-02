const express = require('express');
const path = require('path');
const mssql = require('mssql');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const { BlobServiceClient } = require('@azure/storage-blob');
const http = require('http');
const dns = require('dns/promises'); // ใช้ promises API สำหรับการตรวจสอบ DNS

const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const app = express();
const port = process.env.PORT || 3000;

let blobServiceClient; // Define globally
let containerClient;  // Define globally

// เก็บ socket ของผู้ใช้
const userSockets = {};

// Azure Blob Storage Configuration
try {
    if (!AZURE_STORAGE_CONNECTION_STRING) {
        throw new Error("AZURE_STORAGE_CONNECTION_STRING is not set.");
    }

    blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
    containerClient = blobServiceClient.getContainerClient("profile-images");
    console.log("Azure Blob Storage connected successfully.");
} catch (error) {
    console.error("Error initializing BlobServiceClient:", error.message);
}

// ตั้งค่า session โดยใช้ default memory store ของ express-session
app.use(
    session({
        secret: 'your-secret-key', // กำหนด secret key สำหรับ session
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: false, // ใช้ true หากใช้ HTTPS
            httpOnly: true,
            maxAge: 24 * 60 * 60 * 1000, // อายุ session 1 วัน
        },
    })
);

// การตั้งค่า Body Parser
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Static Files
app.use(express.static(path.join(__dirname, 'public')));

app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

app.use((req, res, next) => {
    console.log(`Incoming request: ${req.method} ${req.url}`);
    next();
});

// Database Configuration
const dbConfig = {
    user: process.env.DB_USER || 'projectcs436',
    password: process.env.DB_PASSWORD || '.cs436team',
    server: process.env.DB_SERVER || 'prohectcs436database.database.windows.net',
    database: process.env.DB_NAME || 'ProjectCS436',
    options: {
        encrypt: true,
        trustServerCertificate: true,
        requestTimeout: 30000, // เพิ่ม requestTimeout เพื่อป้องกันการ timeout เร็วเกินไป
    },
}; 

// Function to Connect to Database with Retry Logic
const connectWithRetry = async () => {
    try {
        await mssql.connect(dbConfig);
    } catch (err) {
        console.error('SQL Server connection failed. Retrying in 5 seconds...', err);
        setTimeout(connectWithRetry, 5000); // Retry after 5 seconds
    }
};

// ตั้งค่า multer สำหรับการอัปโหลด
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/uploads/profile_images'); // โฟลเดอร์สำหรับเก็บรูปภาพ
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    },
});

const upload = multer({
    storage: multer.memoryStorage(), // ใช้ memoryStorage เพื่อรองรับการส่งไฟล์ไปยัง Blob Storage
});

connectWithRetry(); // เรียกใช้การเชื่อมต่อฐานข้อมูลพร้อม Retry Logic
// Connect to Database
mssql.connect(dbConfig)
    .then(() => console.log("Connected to SQL Server"))
    .catch(err => console.error('SQL Server connection failed', err));

const checkNotLoggedIn = (req, res, next) => {
    if (req.session && req.session.user) {
        // หากล็อกอินอยู่ ให้ Redirect ไปหน้า Mail
        return res.redirect('/mail');
    }
    next();
};
const checkLoggedIn = (req, res, next) => {
    if (!req.session || !req.session.user) {
        // หากไม่ได้ล็อกอิน ให้ Redirect ไปหน้า Signin
        return res.redirect('/signin');
    }
    next();
};
    
// Middleware for Login Check
function requireLogin(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ success: false, message: 'Unauthorized: Please log in.' });
    }
    next();
}

app.get('/check_session', async (req, res) => {
    if (req.session && req.session.user) {
        try {
            const userId = req.session.user.id;

            // ตรวจสอบว่ามีค่า profile_image_url ใน session หรือไม่
            if (!req.session.user.profile_image_url || req.session.user.profile_image_url.trim() === "") {
                console.log("Fetching profile_image_url from database for user ID:", userId);

                const request = new mssql.Request();
                const result = await request
                    .input('user_id', mssql.Int, userId)
                    .query('SELECT profile_image_url FROM dbo.users WHERE id = @user_id');

                if (result.recordset.length > 0) {
                    req.session.user.profile_image_url =
                        result.recordset[0].profile_image_url || "https://profilecs436.blob.core.windows.net/profile-images/default-profile.png.webp";
                }
            }

            res.json({
                success: true,
                user: {
                    email: req.session.user.email,
                    profile_image_url: req.session.user.profile_image_url,
                },
            });
        } catch (err) {
            console.error("Error fetching profile image URL:", err);
            res.status(500).json({ success: false, message: "Failed to fetch session" });
        }
    } else {
        res.status(401).json({ success: false, message: "Unauthorized" });
    }
});

app.get('/health', async (req, res) => {
    try {
        const pool = await mssql.connect(dbConfig);
        res.status(200).send('Server is healthy');
        pool.close();
    } catch (err) {
        res.status(500).send('Database connection failed');
    }
});

// Logout Endpoint
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Failed to destroy session:', err);
            return res.status(500).json({ success: false, message: 'Failed to logout' });
        }
        res.clearCookie('connect.sid'); // ลบ session cookie
        res.redirect('/signin'); // redirect ไปที่หน้า signin
    });
});

// Routes
app.get('/', (req, res) => {
    res.send('Server is running');
    res.send('Azure Blob Storage setup completed.');
});

app.get('/signin', checkNotLoggedIn, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'signin.html')); // ใช้ path แบบ relative ไปยังโฟลเดอร์ public
});

app.get('/signup', checkNotLoggedIn, (req, res) => {
    res.sendFile(path.join(__dirname,'public', 'signup.html'));
});

app.get('/mail', checkLoggedIn, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'mail.html'));
});

// Sign In
app.post('/signin', async (req, res) => {
    let { username, password } = req.body;

    // ลบช่องว่างก่อน-หลัง และตรวจสอบว่ามีข้อมูล
    username = username?.trim();
    password = password?.trim();

    if (!username || !password) {
        return res.status(400).json({
            success: false,
            message: 'Username or password cannot be empty or contain only spaces',
        });
    }

    try {
        const request = new mssql.Request();
        request.input('username', mssql.NVarChar, username);
        const result = await request.query('SELECT * FROM users WHERE username = @username');

        if (result.recordset.length === 0) {
            return res.status(401).json({ success: false, message: 'User or Password incorrect' });
        }

        const user = result.recordset[0];
        const isMatch = await bcrypt.compare(password, user.password);

        if (isMatch) {
            req.session.user = {
                id: user.id,
                username: user.username,
                email: user.email,
            };

            res.json({ success: true, message: 'Login successful' });
        } else {
            res.status(401).json({ success: false, message: 'User or Password incorrect' });
        }
    } catch (err) {
        console.error('Error during login:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Sign Up
app.post('/signup', upload.single('profileImage'), async (req, res) => {
    const { username, email, password, firstName, lastName, phone } = req.body;

    // Validation
    const noSpaceRegex = /^[^\s]+$/; // ห้ามมี space ทั้งหมด
    const nameRegex = /^[a-zA-Z]+$/; // Letters only
    const phoneRegex = /^[0-9]{10}$/; // 10 digits only
    const emailRegex = /^[a-zA-Z0-9._%+-]+@(gmail\.com|bumail\.net|bu\.ac\.th)$/; // Allowed email domains

    if (!noSpaceRegex.test(username)) {
        return res.status(400).json({ success: false, message: 'Username cannot contain spaces.' });
    }

    if (!emailRegex.test(email)) {
        return res.status(400).json({ success: false, message: 'Email must be a valid @gmail.com, @bumail.net, or @bu.ac.th address.' });
    }

    if (!noSpaceRegex.test(password)) {
        return res.status(400).json({ success: false, message: 'Password cannot contain spaces.' });
    }

    if (!nameRegex.test(firstName)) {
        return res.status(400).json({ success: false, message: 'First Name can only contain letters.' });
    }

    if (!nameRegex.test(lastName)) {
        return res.status(400).json({ success: false, message: 'Last Name can only contain letters.' });
    }

    if (!phoneRegex.test(phone)) {
        return res.status(400).json({ success: false, message: 'Phone number must be exactly 10 digits.' });
    }

    try {
        const request = new mssql.Request();
        request.input('username', mssql.NVarChar, username);
        request.input('email', mssql.NVarChar, email);

        const result = await request.query('SELECT * FROM users WHERE username = @username OR email = @email');

        if (result.recordset.length > 0) {
            return res.status(400).json({ success: false, message: 'Username or email already exists.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        let profileImageUrl = "https://profilecs436.blob.core.windows.net/profile-images/default-profile.png.webp";

        if (req.file) {
            const blobName = `${Date.now()}-${path.basename(req.file.originalname)}`;
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);

            await blockBlobClient.uploadData(req.file.buffer, {
                blobHTTPHeaders: { blobContentType: req.file.mimetype },
            });

            profileImageUrl = blockBlobClient.url;
        }

        request.input('hashedPassword', mssql.NVarChar, hashedPassword);
        request.input('firstName', mssql.NVarChar, firstName);
        request.input('lastName', mssql.NVarChar, lastName);
        request.input('phone', mssql.NVarChar, phone);
        request.input('profileImageUrl', mssql.NVarChar, profileImageUrl);

        await request.query(`
            INSERT INTO users (username, email, password, firstName, lastName, phone, profile_image_url)
            VALUES (@username, @email, @hashedPassword, @firstName, @lastName, @phone, @profileImageUrl)
        `);

        res.json({ success: true, message: 'Registration successful' });
    } catch (err) {
        console.error('Error during registration:', err);
        res.status(500).json({ success: false, message: 'Failed to register user.' });
    }
});

app.get('/fetch_message', requireLogin, async (req, res) => {
    const email = req.session.user?.email;
    const mode = req.query.mode || 'inbox';

    try {
        const request = new mssql.Request();
        let query = '';

        if (mode === 'inbox') {
            query = `
                SELECT 
                    mails.id, 
                    mails.sender, 
                    mails.recipient, 
                    mails.subject, 
                    mails.message, 
                    mails.sent_at, 
                    mails.is_read_by_recipient AS is_read, 
                    users.username AS sender_username,
                    users.profile_image_url AS profile_image
                FROM dbo.mails 
                LEFT JOIN dbo.users ON dbo.mails.sender = dbo.users.email
                WHERE recipient = @userEmail
                ORDER BY mails.sent_at DESC
            `;
        } else if (mode === 'sent') {
            query = `
                SELECT 
                    mails.id, 
                    mails.sender, 
                    mails.recipient, 
                    mails.subject, 
                    mails.message, 
                    mails.sent_at, 
                    mails.is_read_by_sender AS is_read, 
                    users.username AS recipient_username,
                    users.profile_image_url AS profile_image
                FROM dbo.mails 
                LEFT JOIN dbo.users ON dbo.mails.recipient = dbo.users.email
                WHERE sender = @userEmail
                ORDER BY mails.sent_at DESC
            `;
        }

        request.input('userEmail', mssql.NVarChar, email);
        const result = await request.query(query);

        res.json(result.recordset);
    } catch (err) {
        console.error('Error fetching messages:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch messages' });
    }
});

// API สำหรับส่งอีเมล
app.post('/send_email', async (req, res) => {
    const { recipient, subject, message } = req.body;
    const sender = req.session.user?.email; // ดึงอีเมลของผู้ส่งจาก session

    if (!sender || !recipient || !message) {
        return res.status(400).json({ success: false, message: 'Sender, recipient, and message are required.' });
    }

    // ตรวจสอบว่าไม่สามารถส่งอีเมลถึงตัวเอง
    if (recipient === sender) {
        return res.status(400).json({ success: false, message: 'You cannot send an email to yourself.' });
    }

    // ตรวจสอบว่า recipient มีอยู่ในฐานข้อมูลหรือไม่
    try {
        const request = new mssql.Request();
        request.input('recipient', mssql.NVarChar, recipient);

        const userCheckResult = await request.query(`
            SELECT COUNT(*) AS userCount FROM dbo.users WHERE email = @recipient
        `);

        const userCount = userCheckResult.recordset[0]?.userCount || 0;

        if (userCount === 0) {
            return res.status(400).json({ success: false, message: 'Recipient email does not exist in the system.' });
        }
    } catch (err) {
        console.error('Error checking recipient in database:', err);
        return res.status(500).json({ success: false, message: 'Error checking recipient in database.' });
    }

    try {
        // บันทึกเมลลงฐานข้อมูล
        const request = new mssql.Request();
        request.input('sender', mssql.NVarChar, sender);
        request.input('recipient', mssql.NVarChar, recipient);
        request.input('subject', mssql.NVarChar, subject || '');
        request.input('message', mssql.NVarChar, message);
        request.input('sent_at', mssql.DateTime, new Date());

        await request.query(`
            INSERT INTO dbo.mails (sender, recipient, subject, message, sent_at)
            VALUES (@sender, @recipient, @subject, @message, @sent_at)
        `);

        // Log การส่งเมล
        console.log(`Email sent from ${sender} to ${recipient}`);

        // ส่ง Event แจ้งเตือน
        if (userSockets[recipient]) {
            console.log(`Recipient ${recipient} is online. Sending new_mail notification.`);
            io.to(userSockets[recipient]).emit('new_mail', {
                sender,
                subject,
                message,
            });
        } else {
            console.log(`Recipient ${recipient} is not online. No notification sent.`);
        }

        res.json({ success: true, message: 'Message sent successfully' });
    } catch (err) {
        console.error('Error sending email:', err);
        res.status(500).json({ success: false, message: 'Failed to send message' });
    }
});

app.post('/delete_mail', requireLogin, async (req, res) => {
    const { id } = req.body; // รับ ID ของอีเมลที่ต้องการลบจาก Body ของคำขอ

    if (!id) {
        return res.status(400).json({ success: false, message: 'Message ID is required' });
    }

    try {
        const request = new mssql.Request();
        await request.input('id', mssql.Int, id).query('DELETE FROM dbo.mails WHERE id = @id');

        res.json({ success: true, message: 'Message deleted successfully' });
    } catch (err) {
        console.error('Error deleting message:', err);
        res.status(500).json({ success: false, message: 'Failed to delete message' });
    }
});

// Endpoint สำหรับอัปโหลดรูปภาพ
app.post('/upload_profile', upload.single('profile_image'), async (req, res) => {
    console.log("POST /upload_profile triggered");

    if (!req.file) {
        console.error("No file uploaded in request");
        return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    try {
        const blobName = `${Date.now()}-${path.basename(req.file.originalname)}`;
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);

        console.log("Uploading image to Blob Storage:", blobName);

        await blockBlobClient.uploadData(req.file.buffer, {
            blobHTTPHeaders: { blobContentType: req.file.mimetype },
        });

        const profileImageUrl = blockBlobClient.url;
        console.log("Uploaded Profile Image URL:", profileImageUrl);

        const userId = req.session.user.id;

        const request = new mssql.Request();
        await request.input('profile_image_url', mssql.NVarChar, profileImageUrl)
            .input('user_id', mssql.Int, userId)
            .query('UPDATE dbo.users SET profile_image_url = @profile_image_url WHERE id = @user_id');

        req.session.user.profile_image_url = profileImageUrl;
        console.log("Session updated with new profile image URL:", req.session.user);

        res.json({ success: true, message: "Profile image updated", url: profileImageUrl });
    } catch (err) {
        console.error("Error uploading profile image:", err);
        res.status(500).json({ success: false, message: "Failed to upload profile image" });
    }
});

app.get('/get_user', requireLogin, async (req, res) => {
    try {
        const request = new mssql.Request();
        const result = await request
            .input('id', mssql.Int, req.session.user.id)
            .query(`
                SELECT id, username, email, firstname, lastname, phone, profile_image_url 
                FROM dbo.users 
                WHERE id = @id
            `);

        if (result.recordset.length > 0) {
            const user = result.recordset[0];
            res.json({
                success: true,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    firstname: user.firstname || "N/A",
                    lastname: user.lastname || "N/A",
                    phone: user.phone,
                    profile_image_url: user.profile_image_url || 'https://profilecs436.blob.core.windows.net/profile-images/default-profile.png.webp',
                },
            });
        } else {
            res.status(404).json({ success: false, message: 'User not found' });
        }
    } catch (err) {
        console.error('Error fetching user data:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch user data' });
    }
});

app.post('/mark_as_read', requireLogin, async (req, res) => {
    const { id, mode } = req.body;

    if (!id || !mode) {
        return res.status(400).json({ success: false, message: 'Message ID and mode are required' });
    }

    try {
        const request = new mssql.Request();

        // อัปเดต `is_read_by_recipient` สำหรับ `inbox` และ `is_read_by_sender` สำหรับ `sent`
        const query = `
            UPDATE dbo.mails
            SET ${mode === 'inbox' ? 'is_read_by_recipient' : 'is_read_by_sender'} = 1
            WHERE id = @id AND ${mode === 'inbox' ? 'recipient' : 'sender'} = @userEmail
        `;

        request.input('id', mssql.Int, id);
        request.input('userEmail', mssql.NVarChar, req.session.user.email);

        const result = await request.query(query);

        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({ success: false, message: 'Message not found or unauthorized' });
        }

        res.json({ success: true, message: 'Message marked as read' });
    } catch (err) {
        console.error('Error marking message as read:', err);
        res.status(500).json({ success: false, message: 'Failed to mark message as read' });
    }
});

// Start Server
app.listen(port, () => console.log(`Server is running on port ${port}`));
//app.listen(port, () => console.log(`Server is running on http://localhost:${port}`));
