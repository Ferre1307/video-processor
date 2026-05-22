const express = require("express");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const app = express();
app.use(express.json());

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
    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      resolve(stdout);
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
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(data);
        }
      });
    });
    req.on("error", reject);
    req.write(fileContent);
    req.end();
  });
}

function getDropboxLink(dropboxPath, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ path: dropboxPath });
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
          const url = (parsed.url || "").replace("www.dropbox.com", "dl.dropboxusercontent.com").replace("?dl=0", "");
          resolve(url);
        } catch {
          reject(data);
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Efectos disponibles ─────────────────────────────────────────────────────
// Cada video recibe un efecto diferente basado en su índice (0-39)

function getEffect(index) {
  const effects = [
    // Zoom in suave
    "zoompan=z='min(zoom+0.0015,1.3)':d=125:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'",
    // Zoom out suave
    "zoompan=z='if(lte(zoom,1.0),1.3,max(1.001,zoom-0.0015))':d=125:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'",
    // Pan izquierda a derecha
    "zoompan=z=1.2:x='if(lte(on,1),0,x+1.5)':y='ih/2-(ih/zoom/2)':d=125",
    // Pan derecha a izquierda
    "zoompan=z=1.2:x='if(lte(on,1),iw,x-1.5)':y='ih/2-(ih/zoom/2)':d=125",
    // Zoom in + pan diagonal
    "zoompan=z='min(zoom+0.001,1.25)':x='iw/2-(iw/zoom/2)+on*0.5':y='ih/2-(ih/zoom/2)':d=125",
    // Sin efecto (video normal)
    "null",
    // Brillo ligeramente aumentado
    "eq=brightness=0.05",
    // Contraste ligeramente aumentado
    "eq=contrast=1.1",
    // Saturación aumentada
    "eq=saturation=1.2",
    // Velocidad ligeramente más rápida (1.05x)
    "setpts=0.95*PTS",
  ];
  return effects[index % effects.length];
}

// ─── Ruta principal ───────────────────────────────────────────────────────────

/**
 * POST /process-video
 * Body:
 * {
 *   video_url: "https://dl.dropboxusercontent.com/.../video.mp4",
 *   audio_url: "https://api.elevenlabs.io/.../audio.mp3",
 *   music_url: "https://dl.dropboxusercontent.com/.../music.mp3",
 *   output_name: "video_par1_vid1.mp4",
 *   effect_index: 0,   // 0-39 para efectos diferentes
 *   dropbox_token: "tu_token_dropbox",
 *   dropbox_output_path: "/Videos-Procesados/video_par1_vid1.mp4"
 * }
 */
app.post("/process-video", async (req, res) => {
  const {
    video_url,
    audio_url,
    music_url,
    output_name,
    effect_index = 0,
    dropbox_token,
    dropbox_output_path,
  } = req.body;

  if (!video_url || !audio_url || !dropbox_token || !dropbox_output_path) {
    return res.status(400).json({ error: "Faltan parámetros obligatorios" });
  }

  const id = Date.now() + "_" + Math.random().toString(36).slice(2);
  const videoPath = path.join(TMP, `input_${id}.mp4`);
  const audioPath = path.join(TMP, `audio_${id}.mp3`);
  const musicPath = music_url ? path.join(TMP, `music_${id}.mp3`) : null;
  const outputPath = path.join(TMP, `output_${id}.mp4`);

  try {
    // 1. Descargar archivos
    console.log("Descargando video...");
    await download(video_url, videoPath);

    console.log("Descargando audio (voz)...");
    await download(audio_url, audioPath);

    if (music_url && musicPath) {
      console.log("Descargando música de fondo...");
      await download(music_url, musicPath);
    }

    // 2. Obtener duración del audio de voz
    const durationOut = await run(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
    );
    const audioDuration = parseFloat(durationOut.trim()) + 0.5;

    // 3. Construir filtros de video
    const effect = getEffect(effect_index);
    let videoFilter = effect === "null" ? "" : `-vf "${effect}"`;

    // 4. Construir comando FFmpeg
    let ffmpegCmd;

    if (music_url && musicPath) {
      // Video + voz en off + música de fondo
      ffmpegCmd = `ffmpeg -y \
        -stream_loop -1 -i "${videoPath}" \
        -i "${audioPath}" \
        -stream_loop -1 -i "${musicPath}" \
        -filter_complex "\
          [1:a]volume=1.0[voice];\
          [2:a]volume=0.15,atrim=0:${audioDuration}[music];\
          [voice][music]amix=inputs=2:duration=first[aout]\
        " \
        ${videoFilter} \
        -map 0:v -map "[aout]" \
        -t ${audioDuration} \
        -c:v libx264 -preset fast -crf 23 \
        -c:a aac -b:a 128k \
        -shortest \
        "${outputPath}"`;
    } else {
      // Video + solo voz en off
      ffmpegCmd = `ffmpeg -y \
        -stream_loop -1 -i "${videoPath}" \
        -i "${audioPath}" \
        ${videoFilter} \
        -map 0:v -map 1:a \
        -t ${audioDuration} \
        -c:v libx264 -preset fast -crf 23 \
        -c:a aac -b:a 128k \
        -shortest \
        "${outputPath}"`;
    }

    console.log("Procesando video con FFmpeg...");
    await run(ffmpegCmd);

    // 5. Subir a Dropbox
    console.log("Subiendo a Dropbox...");
    await uploadToDropbox(outputPath, dropbox_output_path, dropbox_token);

    // 6. Obtener link de Dropbox
    const dropboxUrl = await getDropboxLink(dropbox_output_path, dropbox_token);

    // 7. Limpiar archivos temporales
    [videoPath, audioPath, musicPath, outputPath].forEach((f) => {
      if (f && fs.existsSync(f)) fs.unlinkSync(f);
    });

    console.log("✅ Video procesado:", dropboxUrl);
    res.json({ success: true, url: dropboxUrl, output: dropbox_output_path });

  } catch (err) {
    console.error("Error:", err);
    [videoPath, audioPath, musicPath, outputPath].forEach((f) => {
      if (f && fs.existsSync(f)) fs.unlinkSync(f);
    });
    res.status(500).json({ error: err.toString() });
  }
});

// Health check
app.get("/", (req, res) => res.json({ status: "ok", message: "Video server running" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
