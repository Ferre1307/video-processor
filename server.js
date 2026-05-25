const express = require("express");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const { normalizeTTS } = require("./tts_pronunciation_map");

const app = express();
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));

const TMP = "/tmp/videos";
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

// ✅ Refresh token — obtiene access token fresco automáticamente
let cachedToken = null;
let tokenExpiry = 0;

function getDropboxToken() {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    if (cachedToken && now < tokenExpiry) return resolve(cachedToken);

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
      client_id: process.env.DROPBOX_APP_KEY,
      client_secret: process.env.DROPBOX_APP_SECRET,
    }).toString();

    const options = {
      hostname: "api.dropboxapi.com",
      path: "/oauth2/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.access_token) {
            cachedToken = parsed.access_token;
            tokenExpiry = now + (parsed.expires_in - 60) * 1000;
            resolve(cachedToken);
          } else {
            reject("No se pudo obtener token: " + data);
          }
        } catch { reject(data); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

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

// Descarga archivo desde Dropbox usando el token (sin URLs que expiren)
function downloadFromDropbox(dropboxPath, dest, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "content.dropboxapi.com",
      path: "/2/files/download",
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Dropbox-API-Arg": JSON.stringify({ path: dropboxPath }),
        "Content-Type": "text/plain",
      },
    };
    const file = fs.createWriteStream(dest);
    const req = https.request(options, (res) => {
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    });
    req.on("error", (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
    req.end();
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

async function generateVoice(text, audioPath, voice = "es-PY-TaniaNeural") {
  const cleanText = normalizeTTS(text)
    .replace(/"/g, "'")
    .replace(/[\x00-\x1F\x7F]/g, " ");

  // Dividir en 2 mitades por oraciones
  const sentences = cleanText.match(/[^.!?]+[.!?]*|[^.!?]+$/g) || [cleanText];
  // Dividir en segmentos de max 400 caracteres
  const parts = [];
  let current = "";
  for (const s of sentences) {
    if ((current + " " + s).trim().length > 1200) {
      if (current.trim()) parts.push(current.trim());
      current = s;
    } else {
      current = (current + " " + s).trim();
    }
  }
  if (current.trim()) parts.push(current.trim());

  const tmpDir = path.dirname(audioPath);
  const segFiles = [];

  for (let i = 0; i < parts.length; i++) {
    const segPath = path.join(tmpDir, `seg_${Date.now()}_${i}.mp3`);
    segFiles.push(segPath);
    await new Promise((resolve, reject) => {
      const txtPath = path.join(tmpDir, `tts_${i}_${Date.now()}.txt`);
      fs.writeFileSync(txtPath, parts[i], "utf8");
      const srtSeg = segPath.replace(".mp3", ".srt");
      const cmd = `python3 /app/tts.py "${txtPath}" "${voice}" "${segPath}" "${srtSeg}"`;
      const tryRun = (attempts) => {
        exec(cmd, { maxBuffer: 1024 * 1024 * 50, timeout: 120000 }, (err, stdout, stderr) => {
          if (err && attempts > 1) {
            setTimeout(() => tryRun(attempts - 1), 2000);
            return;
          }
          try { fs.unlinkSync(txtPath); } catch {}
          if (err) return reject(stderr || err.message);
          const stats = fs.existsSync(segPath) ? fs.statSync(segPath) : null;
          console.log("MP3 SIZE seg " + i + ":", stats ? stats.size : "NO EXISTE");
          resolve();
        });
      };
      tryRun(3);
    });
  }

  if (segFiles.length === 1) {
    fs.renameSync(segFiles[0], audioPath);
    return audioPath;
  }

  // Concatenar las 2 partes
  const listFile = path.join(tmpDir, `list_${Date.now()}.txt`);
  fs.writeFileSync(listFile, segFiles.map(f => `file '${f}'`).join("\n"));
  await new Promise((resolve, reject) => {
    exec(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:a libmp3lame -q:a 4 "${audioPath}"`,
      { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
        if (err) return reject(stderr || err.message);
        resolve();
      });
  });

  // Concatenar SRT files
  const srtFiles = segFiles.map(f => f.replace(".mp3", ".srt"));
  let srtContent = "";
  let subIndex = 1;
  let timeOffset = 0;
  for (const srtFile of srtFiles) {
    if (fs.existsSync(srtFile)) {
      const lines = fs.readFileSync(srtFile, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (/^\d+$/.test(lines[i].trim())) {
          srtContent += subIndex++ + "\n";
        } else {
          srtContent += lines[i] + "\n";
        }
      }
      try { fs.unlinkSync(srtFile); } catch {}
    }
  }
  if (srtContent.trim()) fs.writeFileSync(srtPath, srtContent, "utf8");

  segFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  try { fs.unlinkSync(listFile); } catch {}

  return audioPath;
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
          if (parsed.url) {
            const directUrl = parsed.url
              .replace("www.dropbox.com", "dl.dropboxusercontent.com")
              .replace("?dl=0", "");
            return resolve(directUrl);
          }
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
              resolve(filePath);
            } else {
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
    video_path,
    text,
    voice = "es-PY-TaniaNeural",
    music_url,
    cut_interval = 10,
    dropbox_token,
    dropbox_output_path,
    portada,
  } = req.body;

  if ((!video_url && !video_path) || !text || !dropbox_output_path) {
    return res.status(400).json({ error: "Faltan parámetros: video_url o video_path, text, dropbox_output_path" });
  }

  const id = Date.now() + "_" + Math.random().toString(36).slice(2);
  const videoPath = path.join(TMP, `input_${id}.mp4`);
  const audioPath = path.join(TMP, `audio_${id}.mp3`);
  const musicPath = music_url ? path.join(TMP, `music_${id}.mp3`) : null;
  const outputPath = path.join(TMP, `output_${id}.mp4`);
  const srtPath = path.join(TMP, `subs_${id}.srt`);

  try {
    // Obtener token fresco automáticamente
    const freshToken = await getDropboxToken();
    console.log("📥 Descargando video...");
    if (video_path && video_path.trim() !== "") {
      console.log("📂 Descargando desde Dropbox API path:", video_path);
      await downloadFromDropbox(video_path, videoPath, freshToken);
    } else if (video_url && video_url.trim() !== "") {
      console.log("🌐 Descargando desde URL:", video_url);
      await download(video_url, videoPath);
    } else {
      throw new Error("Se requiere video_path o video_url");
    }

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

    // Efectos aleatorios por video
    const speed = 1.0;



    const fadeIn = "fade=t=in:st=0:d=0.4";
    const videoSpeed = speed !== 1.0 ? "setpts=" + (1/speed).toFixed(3) + "*PTS," : "";
    const audioSpeed = speed !== 1.0 ? ",atempo=" + speed.toFixed(3) : "";

    // Gancho desde portada del Sheet - texto completo dividido en lineas
    const ganchoRaw = (portada || text.split(' ').slice(0,6).join(' '))
      .replace(/[\r\n]+/g, ' ').trim()
      .replace(/'/g, '')
      .replace(/[{}\[\]\\:=@#%&*<>|;"]/g, '');
    const ganchoWords = ganchoRaw.split(' ');
    const totalWords = ganchoWords.length;
    const wordsPerLine = Math.ceil(totalWords / 3);
    const line1 = ganchoWords.slice(0, wordsPerLine).join(' ');
    const line2 = ganchoWords.slice(wordsPerLine, wordsPerLine * 2).join(' ');
    const line3 = ganchoWords.slice(wordsPerLine * 2).join(' ');
    const fontfile = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
    const dt1 = line1 ? "drawtext=text='" + line1 + "':fontsize=28:fontcolor=black:fontfile=" + fontfile + ":box=1:boxcolor=white@0.9:boxborderw=15:x=(w-text_w)/2:y=(h/2)-90:enable='between(t,0,3)'" : '';
    const dt2 = line2 ? "drawtext=text='" + line2 + "':fontsize=28:fontcolor=black:fontfile=" + fontfile + ":box=1:boxcolor=white@0.9:boxborderw=15:x=(w-text_w)/2:y=(h/2)-10:enable='between(t,0,3)'" : '';
    const dt3 = line3 ? "drawtext=text='" + line3 + "':fontsize=28:fontcolor=black:fontfile=" + fontfile + ":box=1:boxcolor=white@0.9:boxborderw=15:x=(w-text_w)/2:y=(h/2)+70:enable='between(t,0,3)'" : '';
    const drawtext = [dt1, dt2, dt3].filter(Boolean).join(',') || dt1
    // Efectos adicionales aleatorios
    // 4 tipos de transiciones, una aleatoria por video aplicada cada 8 segundos
    const transitionTypes = ["crossfade", "wipeleft", "circleout", "fadecolor"];
    const transType = transitionTypes[Math.floor(Math.random() * transitionTypes.length)];
    const interval = 8;
    let transFilter = "";

    for (let t = interval; t < audioDuration; t += interval) {
      const fo = (t - 0.4).toFixed(2);
      const fi = t.toFixed(2);
      if (transType === "crossfade") {
        // Fundido cruzado: fade out y fade in superpuestos
        transFilter += `,fade=t=out:st=${fo}:d=0.4`;
        transFilter += `,fade=t=in:st=${fi}:d=0.4`;
      } else if (transType === "wipeleft") {
        // Barrido a la izquierda: fade out rápido blanco
        transFilter += `,fade=t=out:st=${fo}:d=0.2:color=white`;
        transFilter += `,fade=t=in:st=${fi}:d=0.2`;
      } else if (transType === "circleout") {
        // Círculo hacia afuera: fade out negro con duración más larga
        transFilter += `,fade=t=out:st=${fo}:d=0.5:color=black`;
        transFilter += `,fade=t=in:st=${fi}:d=0.5`;
      } else if (transType === "fadecolor") {
        // Desvanecimiento a color: fade a gris azulado
        transFilter += `,fade=t=out:st=${fo}:d=0.35:color=0x1a1a2e`;
        transFilter += `,fade=t=in:st=${fi}:d=0.35`;
      }
    }

    const subtitleFilter = fs.existsSync(srtPath) 
      ? `,subtitles='${srtPath}':force_style='FontName=Arial,FontSize=18,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=2,Shadow=1,Alignment=2,MarginV=40,Bold=1'`
      : "";
    const vfFilter = "scale=720:1280,format=yuv420p" + transFilter + "," + fadeIn + subtitleFilter + "," + drawtext;
    console.log("🎬 Transición: " + transType);

    // ✅ FIX pantalla negra: -vf para video, filter_complex SOLO para audio
    let ffmpegCmd;
    if (music_url && musicPath) {
      ffmpegCmd = "ffmpeg -y" +
        " -stream_loop -1 -i \"" + videoPath + "\"" +
        " -i \"" + audioPath + "\"" +
        " -stream_loop -1 -i \"" + musicPath + "\"" +
        " -filter_complex \"[1:a]volume=1.0" + audioSpeed + "[voice];[2:a]volume=0.25,atrim=0:" + audioDuration + "[music];[voice][music]amix=inputs=2:duration=longest[aout]\"" +
        " -map 0:v:0" +
        " -map \"[aout]\"" +
        " -vf \"" + vfFilter + "\"" +
        " -t " + audioDuration +
        " -c:v libx264 -preset ultrafast -crf 28" +
        " -c:a aac -b:a 96k" +
        " -shortest" +
        " \"" + outputPath + "\"";
    } else {
      ffmpegCmd = "ffmpeg -y" +
        " -stream_loop -1 -i \"" + videoPath + "\"" +
        " -i \"" + audioPath + "\"" +
        " -filter_complex \"[1:a]volume=1.0" + audioSpeed + "[aout]\"" +
        " -map 0:v:0" +
        " -map \"[aout]\"" +
        " -vf \"" + vfFilter + "\"" +
        " -t " + audioDuration +
        " -c:v libx264 -preset ultrafast -crf 28" +
        " -c:a aac -b:a 96k" +
        " -shortest" +
        " \"" + outputPath + "\"";
    }


    console.log("🎬 Procesando con FFmpeg (modo bajo RAM)...");
    await run(ffmpegCmd);

    const finalOutputPath = await getUniqueDropboxPath(dropbox_output_path, freshToken);
    console.log("📁 Guardando como:", finalOutputPath);

    console.log("☁️ Subiendo a Dropbox...");
    await uploadToDropbox(outputPath, finalOutputPath, freshToken);

    const dropboxUrl = await getDropboxLink(finalOutputPath, freshToken);

    [videoPath, audioPath, musicPath, outputPath, srtPath].forEach((f) => {
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
