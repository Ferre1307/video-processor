const express = require("express");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const app = express();
app.use(express.json({ limit: "50mb" }));

const TMP = "/tmp/videos";
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

// ─── Helpers ────────────────────────────────────────────────────────────────

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const client = url.startsWith("https") ? https : http;
    client.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 100 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      resolve(stdout);
    });
  });
}

// Genera voz con edge-tts (Microsoft TTS - completamente gratis)
function generateVoice(text, audioPath, voice = "es-PY-TaniaNeural") {
  return new Promise((resolve, reject) => {
    const cmd = `edge-tts --voice "${voice}" --text "${text.replace(/"/g, "'")}" --write-media "${audioPath}"`;
    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      resolve(audioPath);
    });
  });
}

function uploadToDropbox(filePath, dropboxPath, token) {
  return new Promise((resolve, reject) => {
    const fileContent = fs.readFileSync(filePath);
    const options = {
      hostname: "content.dropboxapi.com",
      path: "/2/files/upload",
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify({
          path: dropboxPath,
          mode: "overwrite",
          autorename: false,
        }),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(data); }
      });
    });
    req.on("error", reject);
    req.write(fileContent);
    req.end();
  });
}

function getDropboxLink(dropboxPath, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      path: dropboxPath,
      settings: { requested_visibility: "public" }
    });
    const options = {
      hostname: "api.dropboxapi.com",
      path: "/2/sharing/create_shared_link_with_settings",
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const url = parsed.url ||
            (parsed.error && parsed.error[".tag"] === "shared_link_already_exists"
              ? parsed.error.metadata.url
              : null);
          if (url) {
            const directUrl = url
              .replace("www.dropbox.com", "dl.dropboxusercontent.com")
              .replace("?dl=0", "");
            resolve(directUrl);
          } else {
            reject(JSON.stringify(parsed));
          }
        } catch { reject(data); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Construir filtro FFmpeg con cortes cada 10s y fade to black ─────────────

function buildFadeFilter(audioDuration, cutInterval = 10, fadeDuration = 0.3) {
  // Genera puntos de corte cada cutInterval segundos
  const cuts = [];
  for (let t = cutInterval; t < audioDuration; t += cutInterval) {
    cuts.push(t);
  }

  if (cuts.length === 0) {
    // Video corto, sin cortes — solo fade in al inicio y fade out al final
    return `fade=t=in:st=0:d=${fadeDuration},fade=t=out:st=${Math.max(0, audioDuration - fadeDuration)}:d=${fadeDuration}`;
  }

  // Construir filtro con fade out antes de cada corte y fade in después
  let filter = `fade=t=in:st=0:d=${fadeDuration}`;
  for (const cut of cuts) {
    const fadeOutStart = cut - fadeDuration;
    const fadeInStart = cut;
    if (fadeOutStart > 0) {
      filter += `,fade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeDuration}`;
      filter += `,fade=t=in:st=${fadeInStart.toFixed(2)}:d=${fadeDuration}`;
    }
  }
  // Fade out final
  filter += `,fade=t=out:st=${Math.max(0, audioDuration - fadeDuration).toFixed(2)}:d=${fadeDuration}`;

  return filter;
}

// ─── Ruta principal ───────────────────────────────────────────────────────────

/**
 * POST /process-video
 * Body:
 * {
 *   video_url: "https://dl.dropboxusercontent.com/.../video.mp4",
 *   text: "Texto del guión para la voz en off",
 *   voice: "es-PY-TaniaNeural",  (opcional)
 *   music_url: "https://dl.dropboxusercontent.com/.../music.mp3",  (opcional)
 *   cut_interval: 10,  (opcional, segundos entre cortes, default 10)
 *   dropbox_token: "tu_token_dropbox",
 *   dropbox_output_path: "/Videos-Procesados/video_par1_vid1.mp4"
 * }
 */
app.post("/process-video", async (req, res) => {
  const {
    video_url,
    text,
    voice = "es-PY-TaniaNeural",
    music_url,
    cut_interval = 10,
    dropbox_token,
    dropbox_output_path,
  } = req.body;

  if (!video_url || !text || !dropbox_token || !dropbox_output_path) {
    return res.status(400).json({ error: "Faltan parámetros: video_url, text, dropbox_token, dropbox_output_path" });
  }

  const id = Date.now() + "_" + Math.random().toString(36).slice(2);
  const videoPath = path.join(TMP, `input_${id}.mp4`);
  const audioPath = path.join(TMP, `audio_${id}.mp3`);
  const musicPath = music_url ? path.join(TMP, `music_${id}.mp3`) : null;
  const outputPath = path.join(TMP, `output_${id}.mp4`);

  try {
    // 1. Descargar video base
    console.log("📥 Descargando video...");
    await download(video_url, videoPath);

    // 2. Generar voz en off con edge-tts
    console.log("🎙️ Generando voz en off con Microsoft TTS...");
    await generateVoice(text, audioPath, voice);

    // 3. Descargar música de fondo
    if (music_url && musicPath) {
      console.log("🎵 Descargando música de fondo...");
      await download(music_url, musicPath);
    }

    // 4. Obtener duración del audio
    const durationOut = await run(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
    );
    const audioDuration = parseFloat(durationOut.trim()) + 0.5;
    console.log(`⏱️ Duración del audio: ${audioDuration}s`);

    // 5. Construir filtro de fade to black cada cut_interval segundos
    const fadeFilter = buildFadeFilter(audioDuration, cut_interval, 0.3);

    // 6. Construir comando FFmpeg
    let ffmpegCmd;
    if (music_url && musicPath) {
      ffmpegCmd = `ffmpeg -y \
        -stream_loop -1 -i "${videoPath}" \
        -i "${audioPath}" \
        -stream_loop -1 -i "${musicPath}" \
        -filter_complex "\
          [0:v]${fadeFilter}[vout];\
          [1:a]volume=1.0[voice];\
          [2:a]volume=0.12,atrim=0:${audioDuration}[music];\
          [voice][music]amix=inputs=2:duration=first[aout]\
        " \
        -map "[vout]" -map "[aout]" \
        -t ${audioDuration} \
        -c:v libx264 -preset fast -crf 23 \
        -c:a aac -b:a 128k \
        -shortest \
        "${outputPath}"`;
    } else {
      ffmpegCmd = `ffmpeg -y \
        -stream_loop -1 -i "${videoPath}" \
        -i "${audioPath}" \
        -vf "${fadeFilter}" \
        -map 0:v -map 1:a \
        -t ${audioDuration} \
        -c:v libx264 -preset fast -crf 23 \
        -c:a aac -b:a 128k \
        -shortest \
        "${outputPath}"`;
    }

    console.log("🎬 Procesando video con FFmpeg...");
    await run(ffmpegCmd);

    // 7. Subir a Dropbox
    console.log("☁️ Subiendo a Dropbox...");
    await uploadToDropbox(outputPath, dropbox_output_path, dropbox_token);

    // 8. Obtener link público
    const dropboxUrl = await getDropboxLink(dropbox_output_path, dropbox_token);

    // 9. Limpiar temporales
    [videoPath, audioPath, musicPath, outputPath].forEach((f) => {
      if (f && fs.existsSync(f)) fs.unlinkSync(f);
    });

    console.log("✅ Video procesado:", dropboxUrl);
    res.json({ success: true, url: dropboxUrl, output: dropbox_output_path });

  } catch (err) {
    console.error("❌ Error:", err);
    [videoPath, audioPath, musicPath, outputPath].forEach((f) => {
      if (f && fs.existsSync(f)) fs.unlinkSync(f);
    });
    res.status(500).json({ error: err.toString() });
  }
});

// Health check
app.get("/", (req, res) => res.json({
  status: "ok",
  message: "Video server running",
  tts: "Microsoft Edge TTS (gratis)",
  effects: "Fade to black cada 10s"
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
