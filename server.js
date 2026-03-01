require("dotenv").config();
console.log("CLIENT ID LOADED:", process.env.GOOGLE_CLIENT_ID);

const express = require("express");
const { google } = require("googleapis");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");

const app = express();

const cors = require("cors");

app.use(cors({
  origin: "http://localhost:5173",
  credentials: true
}));
app.use(express.json());

app.use(cookieParser());

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile"
];

// Health endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});



function requireAdmin(req, res, next) {
  if (req.query.secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

function requireAuth(req, res, next) {
  const token = req.cookies.token;

  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid session" });
  }
}

async function findExistingEvent(calendarApi, calendarId, deventId) {
  const response = await calendarApi.events.list({
    calendarId,
    privateExtendedProperty: `mydevent_event_id=${deventId}`,
    singleEvents: true
  });

  const events = response.data.items || [];

  return events.length > 0 ? events[0] : null;
}


//Step 1: Redirect to Google
app.get("/auth/google", (req, res) => {

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES
  });

  res.redirect(url);
});

// Step 2: Google callback
app.get("/auth/google/callback", async (req, res) => {
  try {
    const pool = require("./db");
    const { code } = req.query;

    if (!code) {
      return res.status(400).json({ error: "Missing code" });
    }

    // 1️⃣ Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // 2️⃣ Get user info
    const oauth2 = google.oauth2({
      auth: oauth2Client,
      version: "v2"
    });

    const { data } = await oauth2.userinfo.get();
    const email = data.email;

    if (!email) {
      return res.status(400).json({ error: "Email not found" });
    }

    // 3️⃣ Upsert user
    const userResult = await pool.query(
      `
      INSERT INTO users (email, refresh_token)
      VALUES ($1, $2)
      ON CONFLICT (email)
      DO UPDATE SET refresh_token = EXCLUDED.refresh_token
      RETURNING *;
      `,
      [email, tokens.refresh_token]
    );

    const user = userResult.rows[0];

    // 4️⃣ Create calendar if missing
    oauth2Client.setCredentials({
      refresh_token: user.refresh_token
    });

    const calendarApi = google.calendar({
      version: "v3",
      auth: oauth2Client
    });

    if (!user.calendar_id) {
      const calendar = await calendarApi.calendars.insert({
        requestBody: {
          summary: "MyDevent"
        }
      });

      await pool.query(
        `UPDATE users SET calendar_id = $1 WHERE id = $2`,
        [calendar.data.id, user.id]
      );

      user.calendar_id = calendar.data.id;
    }

    // 5️⃣ Create session
    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.cookie("token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none"
    });

    // 6️⃣ Redirect to frontend (temporary redirect to root)
    res.redirect("http://localhost:5173");

  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).json({ error: "OAuth failed" });
  }
});

// Calender route
app.get("/setup-calendar", async (req, res) => {
  try {
    oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN
    });

    const calendarApi = google.calendar({ version: "v3", auth: oauth2Client });

    // 1️⃣ List calendars
    const calendarList = await calendarApi.calendarList.list();

    const existing = calendarList.data.items.find(
      cal => cal.summary === "MyDevent"
    );

    if (existing) {
      return res.json({
        message: "Calendar already exists",
        calendarId: existing.id
      });
    }

    // 2️⃣ Create if not exists
    const newCalendar = await calendarApi.calendars.insert({
      requestBody: {
        summary: "MyDevent",
        timeZone: "Europe/Oslo"
      }
    });

    res.json({
      message: "Calendar created",
      calendarId: newCalendar.data.id
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Calendar setup failed" });
  }
});

app.get("/test-calendar", async (req, res) => {
  try {
    oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN
    });

    const calendarApi = google.calendar({ version: "v3", auth: oauth2Client });

    const calendarId = process.env.GOOGLE_CALENDAR_ID;

    const eventMarker = "DEVENT_EVENT_ID:TEST123";

    const startTime = new Date(Date.now() + 3600000);
    const endTime = new Date(Date.now() + 7200000);

    const existing = await findExistingEvent(
      calendarApi,
      calendarId,
      eventData.id
    );

    if (existing) {
	return existing.id;
    }

    const event = await calendarApi.events.insert({
  calendarId,
  requestBody: {
    summary: eventData.name,
    description: eventData.link || "",
    start: {
      dateTime: startTime.toISOString(),
      timeZone: "Europe/Oslo"
    },
    end: {
      dateTime: endTime.toISOString(),
      timeZone: "Europe/Oslo"
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 1440 },
        { method: "popup", minutes: 0 }
      ]
    },
    extendedProperties: {
      private: {
        mydevent_event_id: eventData.id
      }
    }
  }
});

    res.json({
      message: "Event created",
      eventId: event.data.id
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Calendar creation failed" });
  }
});

const axios = require("axios");

app.get("/sync-events", requireAdmin,  async (req, res) => {
  try {
    const url = "https://eventslandingpage-2hgltqwriq-ey.a.run.app/";

    const response = await axios.get(url, {
      timeout: 10000,
      headers: { "User-Agent": "MyDevent Backend" }
    });

    if (!Array.isArray(response.data)) {
      return res.status(500).json({
        error: "Unexpected API format"
      });
    }

    const events = response.data;
    const pool = require("./db");

    let inserted = 0;
    let updated = 0;

    for (const e of events) {
      if (!e.id) continue;

      const startSell = e.startSell ? new Date(e.startSell) : null;
      const startDate = e.startDate ? new Date(e.startDate) : null;

      const result = await pool.query(
        `
        INSERT INTO events (id, name, club, start_sell, start_date, link, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (id)
        DO UPDATE SET
          name = EXCLUDED.name,
          club = EXCLUDED.club,
          start_sell = EXCLUDED.start_sell,
          start_date = EXCLUDED.start_date,
          link = EXCLUDED.link,
          updated_at = NOW()
        RETURNING xmax;
        `,
        [
          e.id,
          e.name || null,
          e.club || null,
          startSell,
          startDate,
          e.link || null
        ]
      );

      // PostgreSQL trick:
      // xmax = 0 → inserted
      // xmax > 0 → updated
      if (result.rows[0].xmax === "0") {
        inserted++;
      } else {
        updated++;
      }
    }

    res.json({
      totalFetched: events.length,
      inserted,
      updated,
      updatedAt: new Date(Date.now()).toLocaleString("en-GB")
    });

  } catch (err) {
    console.error("SYNC ERROR:", err);
    res.status(500).json({
      error: "Sync failed"
    });
  }
});




const pool = require("./db");

app.get("/init-db", async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        name TEXT,
        club TEXT,
        start_sell TIMESTAMP,
        start_date TIMESTAMP,
        link TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    res.json({ message: "DB initialized" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "DB init failed" });
  }
});

app.get("/events", async (req, res) => {
  try {
    const pool = require("./db");

    const result = await pool.query(`
      SELECT
        id,
        name,
        club,
        start_sell,
        start_date,
        link
      FROM events
      WHERE start_date >= CURRENT_DATE
      ORDER BY start_sell ASC NULLS LAST;
    `);

    res.json({
      count: result.rows.length,
      events: result.rows
    });

  } catch (err) {
    console.error("EVENTS FETCH ERROR:", err);
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

app.post("/events/:id/interested", requireAuth, async (req, res) => {
  try {
    const pool = require("./db");
    const eventId = req.params.id;

    // 1️⃣ Get event from DB
    const eventResult = await pool.query(
      `SELECT * FROM events WHERE id = $1`,
      [eventId]
    );

    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: "Event not found" });
    }

    const eventData = eventResult.rows[0];

    // 2️⃣ Get  user
    const userResult = await pool.query(
  `SELECT * FROM users WHERE id = $1`,
  [req.user.userId]
);

    if (userResult.rows.length === 0) {
      return res.status(400).json({ error: "No user configured" });
    }

    const user = userResult.rows[0];

    // 3️⃣ Check if already marked interested
    const existingRelation = await pool.query(
      `
      SELECT * FROM user_events
      WHERE user_id = $1 AND event_id = $2
      `,
      [user.id, eventId]
    );

    if (existingRelation.rows.length > 0) {
      return res.json({
        message: "Already INTERESSERT",
        calendarEventId: existingRelation.rows[0].calendar_event_id
      });
    }

    // 4️⃣ Setup Google client
    oauth2Client.setCredentials({
      refresh_token: user.refresh_token
    });

    const calendarApi = google.calendar({
      version: "v3",
      auth: oauth2Client
    });

    // 5️⃣ Duplicate check via extendedProperties
    const existingCalendarEvent = await calendarApi.events.list({
      calendarId: user.calendar_id,
      privateExtendedProperty: `mydevent_event_id=${eventId}`,
      singleEvents: true
    });

    let calendarEventId;

    if (existingCalendarEvent.data.items.length > 0) {
      calendarEventId = existingCalendarEvent.data.items[0].id;
    } else {
      const startTime = eventData.start_sell || eventData.start_date;

      const created = await calendarApi.events.insert({
        calendarId: user.calendar_id,
        requestBody: {
          summary: eventData.name,
          description: eventData.link || "",
          start: {
            dateTime: new Date(startTime).toISOString(),
            timeZone: "Europe/Oslo"
          },
          end: {
            dateTime: new Date(new Date(startTime).getTime() + 60 * 60 * 1000).toISOString(),
            timeZone: "Europe/Oslo"
          },
          reminders: {
            useDefault: false,
            overrides: [
              { method: "popup", minutes: 1440 },
              { method: "popup", minutes: 0 }
            ]
          },
          extendedProperties: {
            private: {
              mydevent_event_id: eventId
            }
          }
        }
      });

      calendarEventId = created.data.id;
    }

    // 6️⃣ Store relation
    await pool.query(
      `
      INSERT INTO user_events (user_id, event_id, status, calendar_event_id)
      VALUES ($1, $2, $3, $4)
      `,
      [user.id, eventId, "INTERESSERT", calendarEventId]
    );

    res.json({
      message: "Marked as INTERESSERT",
      calendarEventId
    });

  } catch (err) {
    console.error("INTEREST ERROR:", err);
    res.status(500).json({ error: "Failed to mark interested" });
  }
});

app.delete("/events/:id/interested", async (req, res) => {
  try {
    const pool = require("./db");
    const eventId = req.params.id;

    // 1️⃣ Get event relation
    const userResult = await pool.query(`SELECT * FROM users WHERE id = $1`);
    if (userResult.rows.length === 0) {
      return res.status(400).json({ error: "No user configured" });
    }

    const user = userResult.rows[0];

    const relationResult = await pool.query(
      `
      SELECT * FROM user_events
      WHERE user_id = $1 AND event_id = $2
      `,
      [user.id, eventId]
    );

    if (relationResult.rows.length === 0) {
      return res.status(404).json({ error: "Not marked as INTERESSERT" });
    }

    const relation = relationResult.rows[0];

    // 2️⃣ Delete calendar event (if exists)
    if (relation.calendar_event_id) {
      oauth2Client.setCredentials({
        refresh_token: user.refresh_token
      });

      const calendarApi = google.calendar({
        version: "v3",
        auth: oauth2Client
      });

      try {
        await calendarApi.events.delete({
          calendarId: user.calendar_id,
          eventId: relation.calendar_event_id
        });
      } catch (err) {
        // If event already deleted in Google, we continue
        if (err.code !== 404) {
          throw err;
        }
      }
    }

    // 3️⃣ Delete DB relation
    await pool.query(
      `
      DELETE FROM user_events
      WHERE user_id = $1 AND event_id = $2
      `,
      [user.id, eventId]
    );

    res.json({
      message: "Removed INTERESSERT and calendar event deleted"
    });

  } catch (err) {
    console.error("DELETE INTEREST ERROR:", err);
    res.status(500).json({ error: "Failed to remove interested" });
  }
});

app.post("/events/:id/pameldt", requireAuth, async (req, res) => {
  try {
    const pool = require("./db");
    const eventId = req.params.id;

    // 1️⃣ Verify event exists
    const eventResult = await pool.query(
      `SELECT id FROM events WHERE id = $1`,
      [eventId]
    );

    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: "Event not found" });
    }

    // 2️⃣ Get user
    const userResult = await pool.query(
      `SELECT id FROM users WHERE id = $1`,
      [req.user.userId]
    );

    const user = userResult.rows[0];

    // 3️⃣ Ensure user already marked INTERESSERT
    const relationResult = await pool.query(
      `
      SELECT * FROM user_events
      WHERE user_id = $1 AND event_id = $2
      `,
      [user.id, eventId]
    );

    if (relationResult.rows.length === 0) {
      return res.status(400).json({
        error: "Must mark INTERESSERT first"
      });
    }

    // 4️⃣ Update status to PÅMELDT
    await pool.query(
      `
      UPDATE user_events
      SET status = 'PÅMELDT'
      WHERE user_id = $1 AND event_id = $2
      `,
      [user.id, eventId]
    );

    res.json({ message: "Marked as PÅMELDT" });

  } catch (err) {
    console.error("PAMELDT ERROR:", err);
    res.status(500).json({ error: "Failed to mark PÅMELDT" });
  }
});





app.get("/me/events", requireAuth, async (req, res) => {
  try {
    const pool = require("./db");

    const userResult = await pool.query(
      `SELECT * FROM users WHERE id = $1`,
      [req.user.userId]
    );

    const user = userResult.rows[0];

    const result = await pool.query(
      `
      SELECT e.*,
             ue.status,
             ue.calendar_event_id
      FROM events e
      LEFT JOIN user_events ue
        ON ue.event_id = e.id
       AND ue.user_id = $1
      WHERE e.start_date >= CURRENT_DATE
      ORDER BY e.start_date ASC
      `,
      [user.id]
    );

    res.json({
      count: result.rows.length,
      events: result.rows
    });

  } catch (err) {
    console.error("ME EVENTS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

//////////////TEMPORARY////////////
app.get("/me", requireAuth, async (req, res) => {
  res.json({ userId: req.user.userId });
});

app.get("/extend-db", async (req, res) => {
  try {
    const pool = require("./db");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE NOT NULL,
        refresh_token TEXT,
        calendar_id TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_events (
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        calendar_event_id TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (user_id, event_id)
      );
    `);

    res.json({ message: "User tables created" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "DB extension failed" });
  }
});

app.get("/create-user", async (req, res) => {
  try {
    const pool = require("./db");

    const result = await pool.query(
      `
      INSERT INTO users (email, refresh_token, calendar_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (email) DO UPDATE
      SET refresh_token = EXCLUDED.refresh_token,
          calendar_id = EXCLUDED.calendar_id
      RETURNING *;
      `,
      [
        "ulvika@mail.com",
        process.env.GOOGLE_REFRESH_TOKEN,
        process.env.GOOGLE_CALENDAR_ID
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "User creation failed" });
  }
});

///////////////////////////////////

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});