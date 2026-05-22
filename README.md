# Video Processor Server

Servidor para procesar videos automáticamente con FFmpeg.
Recibe video base + voz en off + música, aplica efectos y sube a Dropbox.

## Efectos disponibles (se asignan por effect_index)

| Index | Efecto |
|-------|--------|
| 0 | Zoom in suave |
| 1 | Zoom out suave |
| 2 | Pan izquierda a derecha |
| 3 | Pan derecha a izquierda |
| 4 | Zoom in + pan diagonal |
| 5 | Sin efecto |
| 6 | Brillo aumentado |
| 7 | Contraste aumentado |
| 8 | Saturación aumentada |
| 9 | Velocidad 1.05x |

## Cómo desplegarlo en Render.com

1. Crea cuenta en https://render.com
2. Clic en "New" → "Web Service"
3. Conecta tu GitHub y sube estos 3 archivos
4. Render detecta render.yaml automáticamente
5. Clic en "Deploy"
6. Copia la URL que te da Render (ej: https://video-processor.onrender.com)

## Cómo llamarlo desde Make

Módulo: HTTP → Make a Request

- URL: https://tu-servidor.onrender.com/process-video
- Method: POST
- Body type: JSON
- Body:
{
  "video_url": "{{URL del video base en Dropbox}}",
  "audio_url": "{{URL del audio de ElevenLabs}}",
  "music_url": "{{URL de la música en Dropbox}}",
  "effect_index": {{número del par 0-39}},
  "dropbox_token": "{{tu token de Dropbox}}",
  "dropbox_output_path": "/Videos-Procesados/{{nombre_video}}.mp4"
}

## Respuesta del servidor

{
  "success": true,
  "url": "https://dl.dropboxusercontent.com/.../video_final.mp4"
}

Usa esta URL directamente en los módulos de Instagram, Facebook y YouTube en Make.

## Flujo completo en Make

1. Google Sheets → lee guión base del día
2. Claude API → genera 10 variaciones del guión
3. ElevenLabs → genera audio para cada variación
4. HTTP → llama al servidor con effect_index diferente (0-9)
5. Servidor procesa y devuelve URL
6. Instagram/Facebook/YouTube → publican con esa URL
