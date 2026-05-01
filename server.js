require("dotenv").config();
console.log("CLIENT ID LOADED:", process.env.GOOGLE_CLIENT_ID);
console.log("MYDEVENT RUNNING NODE VERSION:", process.version);

const express = require("express");
const { google } = require("googleapis");
const { chromium } = require('playwright');
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const axios = require("axios")
const pool = require("./db");
const cheerio = require("cheerio");
const PORT = process.env.PORT || 3000;

const app = express();

const cors = require("cors");

const debugMode = false;

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:4173",
  "https://mydevent.app"
]

// Helper to get browser (reusable)
let browser = null; 
async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });
  }
  return browser;
}

app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error("Not allowed by CORS"))
    }
  },
  credentials: true,
  allowedHeaders: [
    "Content-Type",
    "Authorization"
  ],
  methods: ["GET","POST","DELETE","PUT","OPTIONS"]
}))

app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    return cors({
      origin: function(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true)
        } else {
          callback(new Error("Not allowed by CORS"))
        }
      },
      credentials: true
    })(req, res, next)
  }
  next()
})

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
   if (req.method === "OPTIONS") return next()   // 🔥 critical
  // const token = req.cookies.token;
  const authHeader = req.headers.authorization

  if (!authHeader) return res.status(401).json({ error: "Unauthorized" })

  const token = authHeader.split(" ")[1]

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

async function getBusyPeriods(user) {

  oauth2Client.setCredentials({
    refresh_token: user.refresh_token
  })

  const calendarApi = google.calendar({
    version: "v3",
    auth: oauth2Client
  })

  const now = new Date()

  const oneYearLater = new Date()
  oneYearLater.setFullYear(now.getFullYear() + 1)

  const response = await calendarApi.events.list({
    calendarId: user.calendar_id,
    q: "BUSY FOR DEVENT",
    singleEvents: true,
    timeMin: now.toISOString(),
    timeMax: oneYearLater.toISOString(),
    orderBy: "startTime",
    maxResults: 250
  })

  return response.data.items.map(e => ({
    start: new Date(e.start.date || e.start.dateTime),
    end: new Date(e.end.date || e.end.dateTime)
  }))
}

function overlapsBusy(startDate, days, busyPeriods) {

  const start = new Date(startDate)

  const end = new Date(start)
  end.setDate(start.getDate() + days - 1)

  return busyPeriods.some(busy =>
    start <= busy.end && end >= busy.start
  )
}

// Helper to pause execution
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Parse dog field to extract name and ID from HTML structure
function parseDogField(dogHtml) {
  // Example: "<strong>Kapow</strong> CMKU/AKE/859/23 <small>(Australian Kelpie)</small>"
  // We need to extract: DogName = "Kapow", dogId = "CMKU/AKE/859/23"
  
  const $ = cheerio.load(dogHtml)
  
  // Get dog name from strong tag
  const dogName = $("strong").text().trim()
  
  // Get registration number (text before the <small> tag)
  const fullText = $.html()
  const regMatch = fullText.match(/<strong[^>]*>[^<]*<\/strong>\s*(\S+)/)
  
  let dogId = null
  if (regMatch && regMatch[1]) {
    // Extract the registration number (e.g., NO50336/21, CMKU/AKE/859/23)
    const regNo = regMatch[1].trim()
    // Extract just the alphanumeric ID part
    const idMatch = regNo.match(/[A-Z0-9]+$/i)
    if (idMatch) {
      dogId = idMatch[0].toUpperCase()
    }
  }
  
  return { dogName, dogId };
}

function matchDog(entry, dogs) {
  if (!entry.externalDogId) return null

  return dogs.find(d => d.dog_id === entry.externalDogId)
}

function extractClasses(schedule) {
  const classes = []

  if (!schedule?.timeTable) return classes

  for (const day of schedule.timeTable) {
    for (const ring of day.dayRings || []) {
      for (const comp of ring.comps || []) {

        // ✅ skip invalid
        if (!comp.id) continue
        if (comp.type === "BREAK") continue

        // Include A (Agility), J (Jumping), H (Hopp)
        if (comp.type !== "A" && comp.type !== "J" && comp.type !== "H") continue

        // Remove the starts === 0 filter - we want to fetch all classes
        // and let the result parsing handle empty ones

        classes.push({
          id: comp.id,
          name: comp.name,
          startTime: comp.startTime,
          type: comp.type,
          size: comp.size,
          level: comp.level
        })
      }
    }
  }

  return classes
}

function parseClass(html, cls) {
  const $ = cheerio.load(html)
  const entries = []

  // Skip if HTML is an error page or Angular loading page
const isAngularLoading = html.includes('app-loading') || 
                        html.includes('ag-root') || 
                        html.includes('spinner');
if ((html.includes("<!doctype html>") && !html.includes("<table") && !html.includes("<TABLE")) || isAngularLoading) {
  console.log(`Class ${cls.id}: No result table (results not published yet or still loading)`)
  return entries
}

  // Find the table by id or just the first table
  const table = $("#startList, table.table").first()
  const rows = table.find("tbody tr, tr")
  
  console.log(`Found ${rows.length} rows in table`)

  rows.each((_, row) => {
    const cols = $(row).find("td")
    
    // Skip if not enough columns
    if (cols.length < 3) return

    const startNumber = $(cols[0]).text().trim()
    const handler = $(cols[1]).text().trim()
    const dogHtml = $(cols[2]).html() // Get HTML, not text

    // Skip header rows
    if (!startNumber || isNaN(parseInt(startNumber))) return

    const parsed = parseDogField(dogHtml)

    entries.push({
      startNumber,
      handler,
      class: cls.name,
      startTime: cls.startTime,
      dogName: parsed.dogName,
      externalDogId: parsed.dogId
    })
  })

  return entries
}

function countMyRuns(entries, dogs) {
  const myDogIds = new Set(dogs.map(d => d.dog_id))
  const counts = {}

  for (const e of entries) {
    if (!myDogIds.has(e.externalDogId)) continue

    counts[e.externalDogId] = (counts[e.externalDogId] || 0) + 1
  }

  return counts
}

function groupRuns(entries, dogs) {
  const myDogIds = new Set(dogs.map(d => d.dog_id))
  const result = {}

  for (const e of entries) {
    if (!myDogIds.has(e.dog_id)) continue

    if (!result[e.dog_id]) {
      result[e.dog_id] = {
        dogId: e.dog_id,
        dogName: e.dogName,
        runs: []
      }
    }

    result[e.dog_id].runs.push({
      class: e.class,
      startNumber: e.startNumber,
      startTime: e.startTime
    })
  }

  return result
}

app.post("/dogs", requireAuth, async (req, res) => {
  try {
    const pool = require("./db")
    const { dogId, name } = req.body

    if (!dogId) {
      return res.status(400).json({ error: "dogId is required" })
    }

    const normalizedDogId = dogId?.trim().toUpperCase() || null
    

    const result = await pool.query(
      `
      INSERT INTO dogs (user_id, dog_id, name)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, dog_id) DO NOTHING
      RETURNING dog_id, name
      `,
      [req.user.userId, normalizedDogId, name || null]
    )

    // If conflict (already exists), fetch existing
    if (result.rows.length === 0) {
      const existing = await pool.query(
        `SELECT dog_id, name FROM dogs WHERE user_id = $1 AND dog_id = $2`,
        [req.user.userId, normalizedDogId]
      )
      return res.json({ dog: existing.rows[0], existed: true })
    }

    res.json({ dog: result.rows[0], existed: false })

  } catch (err) {
    console.error("ADD DOG ERROR:", err)
    res.status(500).json({ error: "Failed to add dog" })
  }
})

// ...existing code...

async function syncEvent(eventId) {
  const pool = require("./db")

  if(!debugMode) return { 
      success: false, 
      error: "not a debug mode"
    };

  try {
    console.log("SYNC START:", eventId)

    // 1️⃣ Try running events API first, then future events API
    let schedule;
    let scheduleRes = await fetch(
      `https://ag.devent.no/public/event/${eventId}/schedule`
    );

    // Check if response is actually JSON (not HTML error page)
    const contentType = scheduleRes.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    
    if (!scheduleRes.ok || !isJson) {
      console.log("First API failed or returned HTML, trying future events API...");
      scheduleRes = await fetch(
        `https://eventschedule-2hgltqwriq-ey.a.run.app/?eventId=${eventId}`
      );
    }

    // Handle API errors gracefully - schedule might not be published yet
    if (!scheduleRes.ok) {
      console.log(`Schedule not available yet (status: ${scheduleRes.status}) - returning success with 0 entries`);
      return { 
        success: true, 
        count: 0,
        message: "Schedule not published yet"
      };
    }

    // Verify the response is JSON
    const contentType2 = scheduleRes.headers.get("content-type") || "";
    if (!contentType2.includes("application/json")) {
      console.log("Response is not JSON - schedule might not be published yet");
      return { 
        success: true, 
        count: 0,
        message: "Schedule not published yet"
      };
    }

    schedule = await scheduleRes.json();

    // 2️⃣ Extract classes
    const classes = extractClasses(schedule)

    console.log("Classes found:", classes.length)

    // If no classes found, schedule might not be published yet
    if (classes.length === 0) {
      console.log("No classes found - schedule might not be published yet");
      return { 
        success: true, 
        count: 0,
        message: "Schedule not published yet"
      };
    }

    let allEntries = []

    // 3️⃣ Fetch & parse each class
    for (const cls of classes) {

  if (cls.starts === 0) {
    console.log("Skipping class (no starts):", cls.id);
    continue;
  }

  try {
    const entries = await fetchWithPlaywright(
      `https://ag.devent.no/public/event/${eventId}/result/${cls.id}`
    );

    if (!entries || entries.length === 0) {
      console.log("⚠️ No entries captured for class:", cls.id);
    } else {
      allEntries.push(...entries);
    }

    await delay(300);

  } catch (err) {
    console.error("Class failed:", cls.id, err);
  }
}

    console.log("Total entries:", allEntries.length)

    // ...rest of the function...

    // 4️⃣ Get user dogs (for matching)
    const dogsRes = await pool.query(`SELECT * FROM dogs`)
    const dogs = dogsRes.rows

    // 5️⃣ Match dogs
    const enrichedEntries = allEntries.map(e => {
      const matched = matchDog(e, dogs)

      return {
        ...e,
        dog_id: matched ? matched.dog_id : null
      }
    })

    // 6️⃣ Replace DB data (atomic)
    await pool.query("BEGIN")

    await pool.query(
      `DELETE FROM event_entries WHERE event_id = $1`,
      [eventId]
    )

    // 7️⃣ Batch insert (IMPORTANT)
    const values = []
    const placeholders = []

    enrichedEntries.forEach((e, i) => {
      const idx = i * 7

      placeholders.push(
        `($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7})`
      )

      values.push(
        eventId,
        e.dogName,
        e.dog_id,
        e.startNumber,
        e.startTime,
        e.class,
        e.externalDogId || null
      )
    })

    if (values.length > 0) {
      await pool.query(
        `
        INSERT INTO event_entries
        (event_id, dog_name, dog_id, start_number, start_time, class, external_dog_id)
        VALUES ${placeholders.join(",")}
        `,
        values
      )
    }

    await pool.query("COMMIT")

    console.log("SYNC DONE:", eventId)

    return { success: true, count: enrichedEntries.length }

  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {}); // Ignore rollback error
    console.error("SYNC ERROR:", err);
    
    return { 
      success: false, 
      error: err.message,
      stack: err.stack 
    };
  }
}

function isEventRunning(e) {
  const now = new Date()

  if (!e.startDate) return false

  const start = new Date(e.startDate)
  const end = e.endDate
    ? new Date(e.endDate)
    : new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000) // +2 days fallback

  return start <= now && now <= end
}

// New function to fetch page with Playwright
// Improved fetchWithPlaywright with retry and fallback
async function fetchWithPlaywright(url, maxRetries = 3) {
  let lastError = null;

  if(!debugMode) return null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    browser = await getBrowser();
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });

    const page = await context.newPage();

    try {
      console.log(`Fetching (attempt ${attempt}/${maxRetries}):`, url);

      await page.route('**/*', route => {
        const reqUrl = route.request().url();
        if (
          reqUrl.includes('stripe.com') ||
          reqUrl.includes('maps.googleapis.com')
        ) {
          return route.abort();
        }
        route.continue();
      });

      const entries = [];
      const seen = new Set();

      await page.waitForTimeout(5000);

      page.on('console', msg => {
        console.log('PAGE LOG:', msg.text());
      });

      page.on('response', async (res) => {
        try {
              const url = res.url();

        if (url.includes('firestore') || url.includes('google')) {
          console.log('🌐 RESP:', url);
        }

        const text = await res.text(); // single read


          if (!text.includes('documentChange')) return;

          // 🔥 Split Firestore stream safely
          const parts = text.split('\n').filter(Boolean);

          for (const part of parts) {
            if (!part.includes('documentChange')) continue;

            try {
              const parsed = JSON.parse(part);

              const doc = parsed.documentChange?.document;
              if (!doc || !doc.fields) continue;
                console.log("📄 DOC:", doc.name);
              if (
                    doc.name.includes('/attendance/') &&
                    doc.name.includes(cls.id) // optional but useful
                  ){

                if (!seen.has(doc.name)) {
                  seen.add(doc.name);

                  const entry = decodeFirestore(doc.fields);
                  entries.push(entry);

                  console.log("✅ ENTRY:", entry);
                }
              }

            } catch {
              // ignore non-JSON lines
            }
          }

        } catch {}
      });

      page.on('websocket', ws => {
        console.log("🔌 WS opened:", ws.url());

        ws.on('framereceived', frame => {
          try {
            const text = frame.payload.toString();

            if (!text.includes('documentChange')) return;

            const parts = text.split('\n').filter(Boolean);

            for (const part of parts) {
              if (!part.includes('documentChange')) continue;

              try {
                const parsed = JSON.parse(part);

                const doc = parsed.documentChange?.document;
                if (!doc || !doc.fields) continue;

                if (doc.name.includes('/attendance/')) {
                  if (!seen.has(doc.name)) {
                    seen.add(doc.name);

                    const entry = decodeFirestore(doc.fields);
                    entries.push(entry);

                    console.log("🔥 WS ENTRY:", entry);
                  }
                }

              } catch {}
            }

          } catch {}
        });
      });

      

      await page.addInitScript(() => {
        Object.defineProperty(document, 'visibilityState', {
          get: () => 'visible',
        });

        Object.defineProperty(document, 'hidden', {
          get: () => false,
        });
      });

      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => false,
        });
      });

      await page.goto(url, { waitUntil: 'networkidle' });

      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });

      await page.mouse.move(100, 200);

      // wait for Firebase stream
      await Promise.race([
        new Promise(resolve => {
          const interval = setInterval(() => {
            if (seen.size > 0) { // 🔥 key change
              clearInterval(interval);
              resolve();
            }
          }, 200);
        }),
        page.waitForTimeout(8000) // longer fallback
      ]);

      /*await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: 60000
      });*/

      console.log("Entries collected:", entries.length);
      console.log("Seen size:", seen.size);
      console.log("Entries:", entries.length);

      return entries;

    } catch (err) {
      console.log(`Attempt ${attempt} failed:`, err.message);
      lastError = err;

      if (attempt < maxRetries) {
        await delay(1000 * attempt);
      }

    } finally {
      await page.close();
    }
  }

  throw lastError;
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

    /*res.cookie("token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none"
    });*/

    // 6️⃣ Redirect to frontend (temporary redirect to root)
    //res.redirect(`${process.env.FRONTEND_URL}?login=success`);

    res.redirect(`${process.env.FRONTEND_URL}?token=${token}`);

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

app.get("/sync-events", requireAdmin,  async (req, res) => {
  if(!debugMode) return res.status(500).json({
        error: "not a debug mode"
      });

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


      await syncEvent(e.id);            // allways parsing


      const startSell = e.startOfTicketSale? new Date(e.startOfTicketSale) : null;
      const startDate = e.startDate ? new Date(e.startDate) : null;
      
      let restrictions = null;

      if (Array.isArray(e.restrictions)) {
        restrictions = parseInt(e.restrictions[0]);
      } else if (e.restrictions !== null && e.restrictions !== undefined) {
        restrictions = parseInt(e.restrictions);
      }

      const result = await pool.query(
  `INSERT INTO events 
     (id, name, start_date, start_sell, club, restrictions, total_percentage, days)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
   ON CONFLICT (id) DO UPDATE SET
     name = EXCLUDED.name,
     start_date = EXCLUDED.start_date,
     start_sell = EXCLUDED.start_sell,
     club = EXCLUDED.club,
     restrictions = EXCLUDED.restrictions,
     total_percentage = EXCLUDED.total_percentage,
     days = EXCLUDED.days
   RETURNING xmax`,
  [
    e.id,
    e.name,
    startDate,
    startSell,
    e.organizer,
    restrictions,
    e.totalPercentage,
    e.days
  ]
);

      // PostgreSQL trick:
      // xmax = 0 → inserted
      // xmax > 0 → updated
      if (result.rows[0].xmax == 0) {
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
    const pool = require("./db")


    // 1️⃣ Get user
    const userResult = await pool.query(
      `SELECT * FROM users WHERE id = $1`,
      [req.user.userId]
    )

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" })
    }



    // 3️⃣ Load events + user state
    const result = await pool.query(
      `
      SELECT
        e.id,
        e.name,
        e.club,
        e.start_sell,
        e.start_date,
        e.days,
        e.link,
        e.restrictions,
        e.total_percentage
      FROM events e
      ORDER BY e.start_date ASC NULLS LAST
      `
    )

    res.json({
      count: result.rows.length,
      events: result.rows
    })

  } catch (err) {
    console.error("EVENTS FETCH ERROR:", err)
    res.status(500).json({ error: "Failed to fetch events" })
  }
})

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

app.delete("/events/:id/interested", requireAuth, async (req, res) => {
  try {
    const pool = require("./db");
    const eventId = req.params.id;

    // 1️⃣ Get event relation
    const userId = req.user.userId;

    const userResult = await pool.query(
      `SELECT * FROM users WHERE id = $1`,
      [userId]
    );

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

app.post("/events/:id/booked", requireAuth, async (req, res) => {
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

    // 4️⃣ Update status to BOOKED
    await pool.query(
      `
      UPDATE user_events
      SET status = 'BOOKED'
      WHERE user_id = $1 AND event_id = $2
      `,
      [user.id, eventId]
    );

    res.json({ message: "Marked as BOOKED" });

  } catch (err) {
    console.error("BOOKED ERROR:", err);
    res.status(500).json({ error: "Failed to mark BOOKED" });
  }
});

app.post("/events/:id/notification", requireAuth, async (req, res) => {
  try {
    const pool = require("./db")
    const eventId = req.params.id
    const userId = req.user.userId

    const userResult = await pool.query(
      `SELECT * FROM users WHERE id = $1`,
      [userId]
    )

    const user = userResult.rows[0]

    const eventResult = await pool.query(
      `SELECT * FROM events WHERE id = $1`,
      [eventId]
    )

    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: "Event not found" })
    }

    const event = eventResult.rows[0]

    const relationResult = await pool.query(
      `SELECT * FROM user_events WHERE user_id = $1 AND event_id = $2`,
      [userId, eventId]
    )

    if (relationResult.rows.length === 0) {
      return res.status(400).json({ error: "Event not marked INTERESSERT" })
    }

    const relation = relationResult.rows[0]

    if (relation.calendar_event_id) {
      return res.json({ message: "Notification already exists" })
    }

    oauth2Client.setCredentials({
      refresh_token: user.refresh_token
    })

    const calendarApi = google.calendar({
      version: "v3",
      auth: oauth2Client
    })

    let calendarEventId

    // Duplicate check
    const existingCalendarEvent = await calendarApi.events.list({
      calendarId: user.calendar_id,
      privateExtendedProperty: `devent_event_id=${eventId}`,
      singleEvents: true
    })

    if (existingCalendarEvent.data.items.length > 0) {
      calendarEventId = existingCalendarEvent.data.items[0].id
    } else {

      const calendarEvent = await calendarApi.events.insert({
        calendarId: user.calendar_id,
        requestBody: {
          summary: `Devent: ${event.name}`,
          description: `${event.club}`,

          start: {
            dateTime: new Date(event.start_sell).toISOString()
          },

          end: {
            dateTime: new Date(
              new Date(event.start_sell).getTime() + 30 * 60000
            ).toISOString()
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
              devent_event_id: eventId
            }
          }
        }
      })

      calendarEventId = calendarEvent.data.id
    }

    await pool.query(
      `
      UPDATE user_events
      SET calendar_event_id = $1
      WHERE user_id = $2 AND event_id = $3
      `,
      [calendarEventId, userId, eventId]
    )

    res.json({
      message: "Notification created",
      calendar_event_id: calendarEventId
    })

  } catch (err) {
    console.error("CREATE NOTIFICATION ERROR:", err)
    res.status(500).json({ error: "Failed to create notification" })
  }
})

app.delete("/events/:id/notification", requireAuth, async (req, res) => {
  try {
    const pool = require("./db")
    const eventId = req.params.id
    const userId = req.user.userId

    const relationResult = await pool.query(
      `
      SELECT ue.*, u.refresh_token, u.calendar_id
      FROM user_events ue
      JOIN users u ON ue.user_id = u.id
      WHERE ue.user_id = $1 AND ue.event_id = $2
      `,
      [userId, eventId]
    )

    if (relationResult.rows.length === 0) {
      return res.status(404).json({ error: "Relation not found" })
    }

    const relation = relationResult.rows[0]

    if (!relation.calendar_event_id) {
      return res.json({ message: "No notification exists" })
    }

    oauth2Client.setCredentials({
      refresh_token: relation.refresh_token
    })

    const calendarApi = google.calendar({
      version: "v3",
      auth: oauth2Client
    })

    try {
      await calendarApi.events.delete({
        calendarId: relation.calendar_id,
        eventId: relation.calendar_event_id
      })
    } catch (err) {
      if (err.code !== 404) throw err
    }

    await pool.query(
      `
      UPDATE user_events
      SET calendar_event_id = NULL
      WHERE user_id = $1 AND event_id = $2
      `,
      [userId, eventId]
    )

    res.json({ message: "Notification removed" })

  } catch (err) {
    console.error("DELETE NOTIFICATION ERROR:", err)
    res.status(500).json({ error: "Failed to delete notification" })
  }
})

app.get("/me/events", requireAuth, async (req, res) => {
  try {
    const pool = require("./db");

    const userResult = await pool.query(
      `SELECT * FROM users WHERE id = $1`,
      [req.user.userId]
    );

    const user = userResult.rows[0];

    // Get BUSY periods from calendar
    const busyPeriods = await getBusyPeriods(user)

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

    // 4️⃣ Attach busy flag
    const events = result.rows.map(e => ({
      id: e.id,
      name: e.name,
      club: e.club,
      start_sell: e.start_sell,
      start_date: e.start_date,
      days: e.days,
      link: e.link,
      restrictions: e.restrictions,
      total_percentage: e.total_percentage,

      status: e.status || null,
      calendar_event_id: e.calendar_event_id || null,

      busy: overlapsBusy(e.start_date, e.days, busyPeriods)
    }))

    res.json({
      count: events.length,
      events: events
    });

  } catch (err) {
    console.error("ME EVENTS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

app.get("/dogs", requireAuth, async (req, res) => {
  const pool = require("./db")

  const dogs = await pool.query(
    `SELECT dog_id, name FROM dogs WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.user.userId]
  )

  res.json({ dogs: dogs.rows })
})


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


app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

app.delete("/dogs/:dogId", requireAuth, async (req, res) => {
  const rawDogId = req.params.dogId

  // 🔥 explicitly decode
  const dogId = decodeURIComponent(rawDogId).trim().toUpperCase()

  await pool.query(
    `DELETE FROM dogs WHERE dog_id = $1 AND user_id = $2`,
    [dogId, req.user.userId]
  )

  res.json({ success: true })
})

app.post("/jobs/sync-event/:id", async (req, res) => {
  const result = await syncEvent(req.params.id)
  res.json(result)
})

app.get("/events/:id/my-runs", requireAuth, async (req, res) => {
  try {
    const pool = require("./db")

    // 1️⃣ get dogs
    const dogsRes = await pool.query(
      `SELECT dog_id, name FROM dogs WHERE user_id = $1`,
      [req.user.userId]
    )

    const dogs = dogsRes.rows

    if (dogs.length === 0) {
      return res.json({ dogs: [] })
    }

    // 2️⃣ get entries
    const entriesRes = await pool.query(
      `SELECT * FROM event_entries WHERE event_id = $1`,
      [req.params.id]
    )

    const entries = entriesRes.rows

    // 3️⃣ group
    const grouped = groupRuns(entries, dogs)

    res.json({
      eventId: req.params.id,
      dogs: Object.values(grouped) 
    })

  } catch (err) {
    console.error("MY RUNS ERROR:", err)
    res.status(500).json({ error: "Failed to get runs" })
  }
})