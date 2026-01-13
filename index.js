import axios from "axios";
import FormData from "form-data";
import fs from "fs";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = "-2400589788";

async function sendImages(image1, image2, caption) {
  const form = new FormData();

  form.append("chat_id", CHAT_ID);

  // MEDIA JSON (QUAN TRỌNG NHẤT)
  form.append(
    "media",
    JSON.stringify([
      {
        type: "photo",
        media: "attach://photo1",
        caption: caption,
        parse_mode: "HTML"
      },
      {
        type: "photo",
        media: "attach://photo2"
      }
    ])
  );

  // FILE ĐÍNH KÈM
  form.append("photo1", fs.createReadStream(image1));
  form.append("photo2", fs.createReadStream(image2));

  await axios.post(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMediaGroup`,
    form,
    { headers: form.getHeaders() }
  );
}

// GỌI HÀM
await sendImages(
  "./capture_1.png",
  "./capture_2.png",
  "<b>BÁO CÁO HÔM NAY</b>\nDữ liệu từ Google Sheet"
);
