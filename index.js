// index.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');
const { google } = require('googleapis');
const sharp = require('sharp');

// ===== Retry Google 429 =====
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

// ===== PDF → PNG =====
function convertPdfToPng(pdfPath, outPrefix) {
  return new Promise((resolve, reject) => {
    execFile(
      'pdftoppm',
      ['-png', '-singlefile', '-r', '150', pdfPath, outPrefix],
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

    // ===== LẤY TIÊU ĐỀ A1:B1 =====
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

    const imagePaths = [];

    // ===== CHỤP 2 ẢNH =====
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

      imagePaths.push(pngPath);
      fs.unlinkSync(pdfPath);
    }

    // ===== GỬI 2 ẢNH LIỀN 1 LẦN – CAPTION Ở ẢNH 2 =====
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
      { headers: form.getHeaders() }
    );

    // ===== DỌN FILE =====
    imagePaths.forEach(p => fs.unlinkSync(p));

    // tránh flood
    await new Promise(r => setTimeout(r, 1500));
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('✅ Hoàn tất – mỗi sheet gửi 2 ảnh, tiêu đề chỉ ở ảnh 2');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
