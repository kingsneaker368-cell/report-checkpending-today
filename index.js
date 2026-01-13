// index.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');
const { google } = require('googleapis');
const sharp = require('sharp');

async function fetchPdfWithRetry(url, headers, attempt = 1) {
  try {
    return await axios.get(url, {
      responseType: 'arraybuffer',
      headers
    });
  } catch (err) {
    if (err.response?.status === 429 && attempt < 5) {
      await new Promise(r => setTimeout(r, 3000));
      return fetchPdfWithRetry(url, headers, attempt + 1);
    }
    throw err;
  }
}

function convertPdfToPng(pdfPath, outPrefix) {
  return new Promise((resolve, reject) => {
    execFile(
      'pdftoppm',
      ['-png', '-singlefile', '-r', '110', pdfPath, outPrefix],
      async err => {
        if (err) return reject(err);
        const pngPath = outPrefix + '.png';
        const trimmed = await sharp(pngPath).trim().toBuffer();
        await fs.promises.writeFile(pngPath, trimmed);
        resolve(pngPath);
      }
    );
  });
}

async function main() {
  const {
    GOOGLE_SERVICE_ACCOUNT_JSON,
    SPREADSHEET_ID,
    SHEET_NAMES,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID
  } = process.env;

  const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/spreadsheets.readonly'
    ]
  );
  await auth.authorize();

  const accessToken = (await auth.getAccessToken()).token;
  const sheetsApi = google.sheets({ version: 'v4', auth });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetpdf-'));
  const sheetNames = SHEET_NAMES.split(',').map(s => s.trim());

  const meta = await sheetsApi.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID
  });

  for (const sheetName of sheetNames) {
    const sheet = meta.data.sheets.find(
      s => s.properties.title === sheetName
    );
    if (!sheet) continue;

    const gid = sheet.properties.sheetId;

    // ===== TITLE A1 + B1 =====
    const titleRes = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1:B1`
    });

    const titleText = (titleRes.data.values?.[0] || [])
      .filter(Boolean)
      .join(' | ');

    const ranges = [
      { start: 1, end: 35, idx: 1 },
      { start: 36, end: 70, idx: 2 }
    ];

    const media = [];
    const buffers = [];

    for (const r of ranges) {
      const range = `${sheetName}!A${r.start}:AO${r.end}`;

      const exportUrl =
        `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=pdf` +
        `&gid=${gid}&portrait=false&fitw=true&gridlines=false` +
        `&range=${encodeURIComponent(range)}`;

      const pdfResp = await fetchPdfWithRetry(exportUrl, {
        Authorization: `Bearer ${accessToken}`
      });

      const pdfPath = path.join(tmpDir, `${sheetName}-${r.idx}.pdf`);
      fs.writeFileSync(pdfPath, pdfResp.data);

      const pngPath = await convertPdfToPng(
        pdfPath,
        pdfPath.replace('.pdf', '')
      );

      buffers.push(fs.readFileSync(pngPath));

      media.push({
        type: 'photo',
        media: `attach://file${r.idx}`
      });

      fs.unlinkSync(pdfPath);
      fs.unlinkSync(pngPath);
    }

    // Caption chỉ gắn cho ảnh đầu
    media[0].caption = titleText;

    const form = new FormData();
    form.append('chat_id', TELEGRAM_CHAT_ID);
    form.append('media', JSON.stringify(media));

    buffers.forEach((buf, i) => {
      form.append(`file${i + 1}`, buf);
    });

    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMediaGroup`,
      form,
      { headers: form.getHeaders() }
    );
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('✅ OK – mỗi sheet gửi 1 album (2 ảnh, 1 tiêu đề)');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
