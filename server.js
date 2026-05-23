const express = require("express");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const app = express();
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));

const TMP = "/tmp/videos";
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

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

function generateVoice(text, audioPath, voice = "es-PY-TaniaNeural") {
  return new Promise((resolve, reject) => {
    // Limpiar texto: eliminar saltos de línea y caracteres especiales
    const cleanText = text
      .replace(/[\r\n]+/g, " ")
      .replace(/"/g, "'")
      .replace(/[\x00-\x1F\x7F]/g, " ")
      .trim();
    const cmd = `edge-tts --voice "${voice}" --lang "es-PY" --text "${cleanText}" --write-media "${audioPath}"`;
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
          // Link creado exitosamente
          if (parsed.url) {
            const directUrl = parsed.url
              .replace("www.dropbox.com", "dl.dropboxusercontent.com")
              .replace("?dl=0", "");
            return resolve(directUrl);
          }
          // Link ya existe — obtener el link existente
          if (parsed.error && parsed.error[".tag"] === "shared_link_already_exists") {
            console.log("Link ya existe, obteniendo link existente...");
            return getExistingDropboxLink(dropboxPath, token).then(resolve).catch(reject);
          }
          reject(JSON.stringify(parsed));
        } catch { reject(data); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function getExistingDropboxLink(dropboxPath, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ path: dropboxPath });
    const options = {
      hostname: "api.dropboxapi.com",
      path: "/2/sharing/list_shared_links",
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
          if (parsed.links && parsed.links.length > 0) {
            const directUrl = parsed.links[0].url
              .replace("www.dropbox.com", "dl.dropboxusercontent.com")
              .replace("?dl=0", "");
            resolve(directUrl);
          } else {
            reject("No se encontro link existente");
          }
        } catch { reject(data); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Genera un nombre único si el archivo ya existe en Dropbox
function getUniqueDropboxPath(dropboxPath, token) {
  return new Promise((resolve) => {
    const checkExists = (filePath, counter) => {
      const body = JSON.stringify({ path: filePath });
      const options = {
        hostname: "api.dropboxapi.com",
        path: "/2/files/get_metadata",
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
            if (parsed.error && parsed.error[".tag"] === "path" &&
                parsed.error.path[".tag"] === "not_found") {
              // Archivo no existe, usar este nombre
              resolve(filePath);
            } else {
              // Archivo existe, generar nuevo nombre
              const ext = path.extname(dropboxPath);
              const base = dropboxPath.slice(0, -ext.length);
              const newPath = `${base}_${counter}${ext}`;
              checkExists(newPath, counter + 1);
            }
          } catch {
            resolve(filePath);
          }
        });
      });
      req.on("error", () => resolve(filePath));
      req.write(body);
      req.end();
    };
    checkExists(dropboxPath, 1);
  });
}

function buildFadeFilter(audioDuration, cutInterval = 10, fadeDuration = 0.3) {
  const cuts = [];
  for (let t = cutInterval; t < audioDuration; t += cutInterval) {
    cuts.push(t);
  }
  if (cuts.length === 0) {
    return `fade=t=in:st=0:d=${fadeDuration},fade=t=out:st=${Math.max(0, audioDuration - fadeDuration)}:d=${fadeDuration}`;
  }
  let filter = `fade=t=in:st=0:d=${fadeDuration}`;
  for (const cut of cuts) {
    const fadeOutStart = cut - fadeDuration;
    const fadeInStart = cut;
    if (fadeOutStart > 0) {
      filter += `,fade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeDuration}`;
      filter += `,fade=t=in:st=${fadeInStart.toFixed(2)}:d=${fadeDuration}`;
    }
  }
  filter += `,fade=t=out:st=${Math.max(0, audioDuration - fadeDuration).toFixed(2)}:d=${fadeDuration}`;
  return filter;
}

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
    console.log("📥 Descargando video...");
    await download(video_url, videoPath);

    console.log("🎙️ Generando voz en off...");
    await generateVoice(text, audioPath, voice);

    if (music_url && musicPath) {
      console.log("🎵 Descargando música...");
      await download(music_url, musicPath);
    }

    const durationOut = await run(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
    );
    const audioDuration = parseFloat(durationOut.trim()) + 0.5;
    console.log(`⏱️ Duración: ${audioDuration}s`);

    const fadeFilter = buildFadeFilter(audioDuration, cut_interval, 0.3);

    // ✅ Usando preset ultrafast y escala 720p para reducir RAM
    let ffmpegCmd;
    if (music_url && musicPath) {
      ffmpegCmd = `ffmpeg -y \
        -stream_loop -1 -i "${videoPath}" \
        -i "${audioPath}" \
        -stream_loop -1 -i "${musicPath}" \
        -filter_complex "\
          [0:v]scale=720:1280,${fadeFilter}[vout];\
          [1:a]volume=1.0[voice];\
          [2:a]volume=0.25,atrim=0:${audioDuration}[music];\
          [voice][music]amix=inputs=2:duration=first[aout]\
        " \
        -map "[vout]" -map "[aout]" \
        -t ${audioDuration} \
        -c:v libx264 -preset ultrafast -crf 28 \
        -c:a aac -b:a 96k \
        -threads 1 \
        -shortest \
        "${outputPath}"`;
    } else {
      ffmpegCmd = `ffmpeg -y \
        -stream_loop -1 -i "${videoPath}" \
        -i "${audioPath}" \
        -filter_complex "[0:v]scale=720:1280,${fadeFilter}[vout]" \
        -map "[vout]" -map 1:a \
        -t ${audioDuration} \
        -c:v libx264 -preset ultrafast -crf 28 \
        -c:a aac -b:a 96k \
        -threads 1 \
        -shortest \
        "${outputPath}"`;
    }

    console.log("🎬 Procesando con FFmpeg (modo bajo RAM)...");
    await run(ffmpegCmd);

    // Generar nombre único si ya existe
    const finalOutputPath = await getUniqueDropboxPath(dropbox_output_path, dropbox_token);
    console.log("📁 Guardando como:", finalOutputPath);

    console.log("☁️ Subiendo a Dropbox...");
    await uploadToDropbox(outputPath, finalOutputPath, dropbox_token);

    const dropboxUrl = await getDropboxLink(finalOutputPath, dropbox_token);

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

app.get("/", (req, res) => res.json({
  status: "ok",
  message: "Video server running - modo bajo RAM",
  resolucion: "720x1280",
  preset: "ultrafast",
  tts: "Microsoft Edge TTS (gratis)"
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
