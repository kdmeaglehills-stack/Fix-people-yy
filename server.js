import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAGNIFIC_API_KEY = process.env.MAGNIFIC_API_KEY || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || 300000);
const DEFAULT_RESOLUTION = process.env.DEFAULT_RESOLUTION || '1K';

const publicDir = path.join(__dirname, 'public');
const uploadsDir = path.join(publicDir, 'uploads');
await fs.mkdir(uploadsDir, { recursive: true });

app.use(express.json({ limit: '80mb' }));
app.use(express.static(publicDir));

app.get('/health', (_req, res) => {
  res.json({ ok: true, hasApiKey: Boolean(MAGNIFIC_API_KEY), publicBaseUrl: PUBLIC_BASE_URL });
});

app.post('/api/fix-people', async (req, res) => {
  try {
    if (!MAGNIFIC_API_KEY) {
      return res.status(500).json({ error: 'MAGNIFIC_API_KEY is missing in Render Environment Variables.' });
    }

    const { imageDataUrl, groups, optionsCount = 1, prompt, resolution = DEFAULT_RESOLUTION, paddingPercent = 0.4 } = req.body || {};

    if (!imageDataUrl || !Array.isArray(groups) || groups.length === 0) {
      return res.status(400).json({ error: 'Upload image and detect people first.' });
    }

    const imageBuffer = dataUrlToBuffer(imageDataUrl);
    const metadata = await sharp(imageBuffer).metadata();
    const imageWidth = metadata.width;
    const imageHeight = metadata.height;

    const runId = uuidv4();
    const results = [];
    const count = Math.max(1, Math.min(6, Number(optionsCount) || 1));

    for (let i = 0; i < groups.length; i++) {
      const padded = expandBox(groups[i].box, imageWidth, imageHeight, paddingPercent);
      const aspectRatio = closestMagnificAspectRatio(padded.width, padded.height);
      const box = fitBoxToAspect(padded, imageWidth, imageHeight, aspectRatio);

      const cropBuffer = await sharp(imageBuffer)
        .extract({ left: box.x, top: box.y, width: box.width, height: box.height })
        .png()
        .toBuffer();

      const cropName = `${runId}_group_${String(i + 1).padStart(2, '0')}.png`;
      await fs.writeFile(path.join(uploadsDir, cropName), cropBuffer);
      const cropUrl = `${PUBLIC_BASE_URL}/uploads/${cropName}`;

      const options = [];
      const generatedUrls = [];

      for (let j = 0; j < count; j++) {
        const created = await createMagnificTask({ cropUrl, prompt, resolution, aspectRatio });
        const taskId = created?.data?.task_id;
        if (!taskId) throw new Error('Magnific did not return task_id.');

        const completed = await pollMagnificTask(taskId);
        const generatedUrl = completed?.data?.generated?.[0];
        if (!generatedUrl) throw new Error('Magnific did not return generated image.');

        generatedUrls.push(generatedUrl);

        const generatedResponse = await fetch(generatedUrl);
        if (!generatedResponse.ok) throw new Error(`Failed to download generated image: ${generatedResponse.status}`);
        const generatedBuffer = Buffer.from(await generatedResponse.arrayBuffer());
        options.push(`data:image/png;base64,${generatedBuffer.toString('base64')}`);
      }

      results.push({
        id: `group-${i + 1}`,
        label: `Group ${i + 1}`,
        box,
        aspectRatio,
        sourceCropUrl: cropUrl,
        generatedUrls,
        options
      });
    }

    res.json({ ok: true, groups: results });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Unknown server error.' });
  }
});

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl).match(/^data:(.+);base64,(.+)$/);
  if (!match) throw new Error('Invalid image data.');
  return Buffer.from(match[2], 'base64');
}

function expandBox(box, imageWidth, imageHeight, paddingPercent) {
  const x = Number(box.x), y = Number(box.y), w = Number(box.width), h = Number(box.height);
  const padX = Math.round(w * paddingPercent);
  const padY = Math.round(h * paddingPercent);
  const left = Math.max(0, Math.round(x - padX));
  const top = Math.max(0, Math.round(y - padY));
  const right = Math.min(imageWidth, Math.round(x + w + padX));
  const bottom = Math.min(imageHeight, Math.round(y + h + padY));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function fitBoxToAspect(box, imageWidth, imageHeight, aspectRatioKey) {
  const target = aspectRatioToNumber(aspectRatioKey);
  let width = box.width, height = box.height;

  if (width / height > target) height = Math.round(width / target);
  else width = Math.round(height * target);

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  let x = Math.round(cx - width / 2);
  let y = Math.round(cy - height / 2);

  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + width > imageWidth) x = Math.max(0, imageWidth - width);
  if (y + height > imageHeight) y = Math.max(0, imageHeight - height);

  width = Math.min(width, imageWidth - x);
  height = Math.min(height, imageHeight - y);

  if (width / height > target) {
    const newWidth = Math.max(1, Math.round(height * target));
    x += Math.floor((width - newWidth) / 2);
    width = newWidth;
  } else {
    const newHeight = Math.max(1, Math.round(width / target));
    y += Math.floor((height - newHeight) / 2);
    height = newHeight;
  }

  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function aspectRatioToNumber(key) {
  const ratios = { '1:1':1, '2:3':2/3, '3:2':3/2, '4:3':4/3, '3:4':3/4, '5:4':5/4, '4:5':4/5, '16:9':16/9, '9:16':9/16, '21:9':21/9 };
  return ratios[key] || 1;
}

function closestMagnificAspectRatio(width, height) {
  const supported = ['1:1','2:3','3:2','4:3','3:4','5:4','4:5','16:9','9:16','21:9'];
  const target = width / height;
  let best = '1:1', bestDiff = Infinity;
  for (const key of supported) {
    const diff = Math.abs(Math.log(target / aspectRatioToNumber(key)));
    if (diff < bestDiff) { best = key; bestDiff = diff; }
  }
  return best;
}

async function createMagnificTask({ cropUrl, prompt, resolution, aspectRatio }) {
  const response = await fetch('https://api.magnific.com/v1/ai/text-to-image/nano-banana-pro-flash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-magnific-api-key': MAGNIFIC_API_KEY },
    body: JSON.stringify({
      prompt,
      reference_images: [{ image: cropUrl, text: 'Reference crop. Preserve the crop framing, scale, perspective, shadows, floor, architecture, and surrounding context.', mime_type: 'image/png' }],
      aspect_ratio: aspectRatio,
      resolution,
      use_google_search_tool: false
    })
  });

  if (!response.ok) throw new Error(`Magnific create failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function pollMagnificTask(taskId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await fetch(`https://api.magnific.com/v1/ai/text-to-image/nano-banana-pro-flash/${taskId}`, {
      headers: { 'x-magnific-api-key': MAGNIFIC_API_KEY }
    });

    if (!response.ok) throw new Error(`Magnific poll failed: ${response.status} ${await response.text()}`);

    const json = await response.json();
    const status = json?.data?.status;

    if (status === 'COMPLETED') return json;
    if (status === 'FAILED' || status === 'CANCELLED') throw new Error(`Magnific task status: ${status}`);

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for task ${taskId}.`);
}

app.listen(PORT, () => {
  console.log(`Fix People tool running on port ${PORT}`);
  console.log(`Public base URL: ${PUBLIC_BASE_URL}`);
});
