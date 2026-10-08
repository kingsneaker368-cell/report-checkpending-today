
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');
const { google } = require('googleapis');
const sharp = require('sharp');

const TIME_ZONE = 'Asia/Ho_Chi_Minh';
const CONFIG_SHEET = 'CAU_HINH_CHUP_NO';
const SLOT_CELLS = ['B5', 'B6', 'B7', 'B8', 'B9'];
const WINDOW_MINUTES = 30;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function vnDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);

  const get = type => parts.find(p => p.type === type)?.value;

  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute'))
  };
}

function normalizeTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;

  const match = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) {
    throw new Error(`Giờ không hợp lệ: "${text}". Dùng HH:mm.`);
  }

  const h = Number(match[1]);
  const m = Number(match[2]);

  if (h > 23 || m > 59) {
    throw new Error(`Giờ không hợp lệ: "${text}".`);
  }

  return h * 60 + m;
}

function quotedSheet(name) {
  return `'${name.replace(/'/g, "''")}'`;
}

async function getCell(sheetsApi, spreadsheetId, cell) {
  const result = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: `${quotedSheet(CONFIG_SHEET)}!${cell}`,
    valueRenderOption: 'FORMATTED_VALUE'
  });

  return result.data.values?.[0]?.[0] ?? '';
}

async function writeStatus(sheetsApi, spreadsheetId, updates) {
  const data = Object.entries(updates).map(([cell, value]) => ({
    range: `${quotedSheet(CONFIG_SHEET)}!${cell}`,
    values: [[String(value)]]
  }));

  await sheetsApi.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data
    }
  });
}

async function readSchedule(sheetsApi, spreadsheetId) {
  const response = await sheetsApi.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: [
      `${quotedSheet(CONFIG_SHEET)}!B3`,
      `${quotedSheet(CONFIG_SHEET)}!B5:B9`,
      `${quotedSheet(CONFIG_SHEET)}!B13`
    ],
    valueRenderOption: 'FORMATTED_VALUE'
  });

  const ranges = response.data.valueRanges || [];
  const enabled = String(ranges[0]?.values?.[0]?.[0] ?? '')
    .trim()
    .toUpperCase();

  const rawSlots = ranges[1]?.values || [];
  const lastSlot = String(ranges[2]?.values?.[0]?.[0] ?? '').trim();

  return {
    enabled: enabled === 'BẬT' || enabled === 'BAT' || enabled === 'ON',
    slots: SLOT_CELLS.map((cell, index) => ({
      index: index + 1,
      cell,
      time: normalizeTime(rawSlots[index]?.[0] ?? '')
    })),
    lastSlot
  };
}

async function fetchPdfWithRetry(url, headers, attempt = 1) {
  try {
    return await axios.get(url, {
      responseType: 'arraybuffer',
      headers,
      timeout: 120000
    });
  } catch (err) {
    if (
      [429, 500, 502, 503, 504].includes(err.response?.status) &&
      attempt < 5
    ) {
      await sleep(3000 * attempt);
      return fetchPdfWithRetry(url, headers, attempt + 1);
    }
    throw err;
  }
}

function convertPdfToPng(pdfPath, outPrefix) {
  return new Promise((resolve, reject) => {
    execFile(
      'pdftoppm',
      ['-png', '-singlefile', '-r', '150', pdfPath, outPrefix],
      async err => {
        if (err) return reject(err);

        try {
          const pngPath = outPrefix + '.png';
          const trimmed = await sharp(pngPath).trim().toBuffer();
          await fs.promises.writeFile(pngPath, trimmed);
          resolve(pngPath);
        } catch (error) {
          reject(error);
        }
      }
    );
  });
}

async function exportSheetsToTelegram(auth, sheetsApi, spreadsheetId) {
  const {
    SHEET_NAMES,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID
  } = process.env;

  if (!SHEET_NAMES || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error('Thiếu SHEET_NAMES hoặc thông tin Telegram trong Secrets.');
  }

  const accessTokenResult = await auth.getAccessToken();
  const accessToken = accessTokenResult.token;

  const sheetNames = SHEET_NAMES
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetpdf-'));

  try {
    const meta = await sheetsApi.spreadsheets.get({
      spreadsheetId
    });

    for (const sheetName of sheetNames) {
      const sheet = meta.data.sheets.find(
        s => s.properties.title === sheetName
      );

      if (!sheet) {
        console.log(`Bỏ qua tab không tồn tại: ${sheetName}`);
        continue;
      }

      const gid = sheet.properties.sheetId;

      const titleRes = await sheetsApi.spreadsheets.values.get({
        spreadsheetId,
        range: `${quotedSheet(sheetName)}!A1:B1`
      });

      const titleText = (titleRes.data.values?.[0] || [])
        .filter(Boolean)
        .join(' | ');

      // Giữ nguyên phạm vi chụp từ chương trình cũ.
      const ranges = [
        { start: 1, end: 39, idx: 1 },
        { start: 33, end: 70, idx: 2 }
      ];

      const imagePaths = [];

      for (const r of ranges) {
        const range = `${sheetName}!A${r.start}:AO${r.end}`;

        const exportUrl =
          `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=pdf` +
          `&gid=${gid}&portrait=false&fitw=true&gridlines=false` +
          `&range=${encodeURIComponent(range)}`;

        const pdfResp = await fetchPdfWithRetry(exportUrl, {
          Authorization: `Bearer ${accessToken}`
        });

        const pdfPath = path.join(
          tmpDir,
          `${sheetName}-${r.idx}.pdf`
        );

        fs.writeFileSync(pdfPath, pdfResp.data);

        const pngPath = await convertPdfToPng(
          pdfPath,
          pdfPath.replace('.pdf', '')
        );

        imagePaths.push(pngPath);
        fs.unlinkSync(pdfPath);
      }

      const form = new FormData();
      form.append('chat_id', TELEGRAM_CHAT_ID);

      form.append(
        'media',
        JSON.stringify([
          {
            type: 'photo',
            media: 'attach://photo1'
          },
          {
            type: 'photo',
            media: 'attach://photo2',
            caption: titleText
          }
        ])
      );

      form.append('photo1', fs.createReadStream(imagePaths[0]));
      form.append('photo2', fs.createReadStream(imagePaths[1]));

      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMediaGroup`,
        form,
        {
          headers: form.getHeaders(),
          timeout: 120000
        }
      );

      imagePaths.forEach(p => fs.unlinkSync(p));

      console.log(`Đã gửi 2 ảnh: ${sheetName}`);
      await sleep(1500);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('Hoàn tất xuất ảnh và gửi Telegram.');
}

async function main() {
  const {
    GOOGLE_SERVICE_ACCOUNT_JSON,
    SPREADSHEET_ID,
    RUN_MODE = 'manual'
  } = process.env;

  if (!GOOGLE_SERVICE_ACCOUNT_JSON || !SPREADSHEET_ID) {
    throw new Error('Thiếu GOOGLE_SERVICE_ACCOUNT_JSON hoặc SPREADSHEET_ID.');
  }

  const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/spreadsheets'
    ]
  );

  await auth.authorize();

  const sheetsApi = google.sheets({
    version: 'v4',
    auth
  });

  if (RUN_MODE !== 'auto') {
    console.log('Chế độ chụp thủ công.');
    await exportSheetsToTelegram(auth, sheetsApi, SPREADSHEET_ID);
    return;
  }

  const schedule = await readSchedule(sheetsApi, SPREADSHEET_ID);

  if (!schedule.enabled) {
    console.log('Tự động đang TẮT. Bỏ qua.');
    return;
  }

  const now = vnDateParts();

  const dueSlots = schedule.slots
    .filter(slot => slot.time !== null)
    .filter(slot =>
      now.minutes >= slot.time &&
      now.minutes < slot.time + WINDOW_MINUTES
    )
    .sort((a, b) => a.time - b.time);

  if (!dueSlots.length) {
    console.log(`Không có lịch đến hạn lúc ${now.date} ${now.time}.`);
    return;
  }

  // Mỗi lần chạy chỉ xử lý một mốc đến hạn.
  const slot = dueSlots[0];
  const slotId = `${now.date}|LAN_${slot.index}|${String(
    Math.floor(slot.time / 60)
  ).padStart(2, '0')}:${String(slot.time % 60).padStart(2, '0')}`;

  if (schedule.lastSlot === slotId) {
    console.log(`Mốc ${slotId} đã chụp thành công. Bỏ qua.`);
    return;
  }

  console.log(`Bắt đầu chụp tự động: ${slotId}`);

  try {
    await writeStatus(sheetsApi, SPREADSHEET_ID, {
      B12: `ĐANG CHẠY - ${now.date} ${now.time}`
    });

    await exportSheetsToTelegram(auth, sheetsApi, SPREADSHEET_ID);

    const finished = vnDateParts();

    await writeStatus(sheetsApi, SPREADSHEET_ID, {
      B11: `${finished.date} ${finished.time}`,
      B12: 'THÀNH CÔNG',
      B13: slotId
    });

    console.log(`Chụp thành công: ${slotId}`);
  } catch (error) {
    const failed = vnDateParts();

    try {
      await writeStatus(sheetsApi, SPREADSHEET_ID, {
        B12: `LỖI ${failed.date} ${failed.time}: ${error.message}`.slice(0, 450)
      });
    } catch (statusError) {
      console.error('Không ghi được trạng thái:', statusError.message);
    }

    throw error;
  }
}

main().catch(error => {
  console.error('Lỗi chương trình:', error);
  process.exit(1);
});
