import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { Readable } from "stream";
import ytdl from "@distube/ytdl-core";
import ytSearch from "yt-search";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "ffmpeg-static";
import { Server } from "socket.io";
import { createServer } from "http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

async function fetchFromRapidAPI(videoId: string) {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) {
    console.warn("RapidAPI key missing in environment");
    return null;
  }

  try {
    console.log("Trying RapidAPI fallback for ID:", videoId);
    // Use headers that the user confirmed in their MCP setup
    const headers = {
      "x-rapidapi-key": key,
      "x-api-key": key, // Added x-api-key as well
      "x-rapidapi-host": "cloud-api-hub-youtube-downloader.p.rapidapi.com",
      "x-api-host": "cloud-api-hub-youtube-downloader.p.rapidapi.com",
      "Content-Type": "application/json"
    };

    // Try highest quality first
    const response = await fetch(`https://cloud-api-hub-youtube-downloader.p.rapidapi.com/download?id=${videoId}&filter=audioandvideo&quality=highest`, {
      headers
    });

    if (response.ok) {
      const data = await response.json();
      console.log("RapidAPI response received successfully");
      
      const formats = [];
      const audioFormats = [];

      // Structure 1: Direct url in root
      if (data.url) {
        formats.push({
          quality: data.quality || 'Highest',
          container: data.extension || 'mp4',
          url: data.url,
          hasVideo: true,
          hasAudio: true,
          itag: 'rapid-direct'
        });
      }

      // Structure 2: formats array
      if (Array.isArray(data.formats)) {
        data.formats.forEach((f: any) => {
          if (f.url) {
            const isAudio = f.vcodec === 'none' || f.audio_ext !== 'none';
            const isVideo = f.acodec === 'none' || (f.video_ext && f.video_ext !== 'none');
            
            const format = {
              quality: f.format_note || f.quality || f.resolution || 'Auto',
              container: f.ext || 'mp4',
              url: f.url,
              hasVideo: isVideo,
              hasAudio: isAudio,
              itag: f.format_id || Math.random().toString(36)
            };

            if (isVideo) formats.push(format);
            else if (isAudio) audioFormats.push(format);
          }
        });
      }

      // Structure 3: links object
      if (data.links && typeof data.links === 'object') {
        Object.entries(data.links).forEach(([ext, qualities]: [string, any]) => {
          if (qualities && typeof qualities === 'object') {
            Object.values(qualities).forEach((q: any) => {
              if (q && (q.url || q.link)) {
                formats.push({
                  quality: q.quality || q.q || 'Auto',
                  container: ext,
                  url: q.url || q.link,
                  hasVideo: true,
                  hasAudio: true,
                  itag: q.itag || Math.random().toString(36)
                });
              }
            });
          }
        });
      }

      if (data.audio_links && typeof data.audio_links === 'object') {
        Object.entries(data.audio_links).forEach(([ext, qualities]: [string, any]) => {
          if (qualities && typeof qualities === 'object') {
            Object.values(qualities).forEach((q: any) => {
              if (q && (q.url || q.link)) {
                audioFormats.push({
                  quality: q.bitrate || q.q || '128',
                  container: ext,
                  url: q.url || q.link,
                  hasVideo: false,
                  hasAudio: true,
                  itag: q.itag || Math.random().toString(36)
                });
              }
            });
          }
        });
      }

      return {
        id: videoId,
        title: data.title || "Video",
        thumbnails: [{ url: data.thumbnail || data.image || `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` }],
        duration: data.duration || 0,
        author: { name: data.author || "YouTube" },
        formats: formats.length > 0 ? formats : (data.url ? [{
          quality: 'Highest',
          container: 'mp4',
          url: data.url,
          hasVideo: true,
          hasAudio: true,
          itag: 'rapid-fallback'
        }] : []),
        audioFormats: audioFormats,
        subtitles: []
      };
    } else {
      console.warn(`RapidAPI source returned HTTP ${response.status}`);
      const errorText = await response.text();
      console.warn("RapidAPI error body:", errorText);
    }
  } catch (e) {
    console.warn("RapidAPI fallback catch error:", e);
  }
  return null;
}
if (ffmpegInstaller) {
  ffmpeg.setFfmpegPath(ffmpegInstaller);
}

function getFriendlyErrorMessage(error: any): string {
  const msg = error?.message?.toLowerCase() || '';
  const code = error?.code?.toLowerCase() || '';
  
  if (msg.includes('confirm you are not a bot') || msg.includes('sign in to confirm') || msg.includes('bot detection')) {
    return 'YouTube blocked the request as automated traffic. Action: Try a different resolution (e.g., 720p instead of 1080p) or wait 15 minutes and retry.';
  }
  
  if (msg.includes('age restricted') || msg.includes('confirm your age')) {
    return 'This video is age-restricted and requires a login. Action: Try searching for an "Unrestricted" version or a different video clip.';
  }

  if (msg.includes('region') || msg.includes('country restriction') || msg.includes('not available in your country')) {
    return 'This video is region-locked by the uploader. Action: This video cannot be downloaded from our current server location. Try a different video.';
  }

  if (msg.includes('private video') || msg.includes('members-only')) {
    return 'This is a private or members-only video. Action: Ensure the video is public and viewable by anyone on YouTube.';
  }

  if (msg.includes('403') || msg.includes('forbidden')) {
    return 'Access denied (403). The temporary link generated by YouTube has expired or changed. Action: Go back, refresh the video info, and click download again immediately.';
  }

  if (msg.includes('410') || msg.includes('gone')) {
    return 'The video source link has expired (410). Action: Close this download, search for the video again, and try a fresh download.';
  }

  if (msg.includes('ffmpeg') || msg.includes('conversion') || msg.includes('codec')) {
    return 'Media conversion failed. This often happens with high-bitrate audio. Action: Try the "Direct Extraction" (M4A) option for faster results.';
  }

  if (msg.includes('timeout') || code === 'etimedout' || code === 'esockettimedout') {
    return 'The server connection timed out. YouTube servers are responding slowly. Action: Click "Retry" to attempt the connection again.';
  }

  if (msg.includes('econnreset') || msg.includes('connection reset')) {
    return 'The network connection was interrupted. Action: Check your internet connection and click "Retry".';
  }

  if (msg.includes('enospc')) {
    return 'Server storage is full. Action: Please try again in 5 minutes after the cache clears.';
  }

  if (msg.includes('itag') || msg.includes('not found') || msg.includes('no such format')) {
    return 'The requested video quality is no longer available from YouTube. Action: Select a different quality (e.g., 720p or 360p) and try again.';
  }

  if (msg.includes('abort') || msg.includes('canceled')) {
    return 'The download was aborted. Action: Click "Retry" to restart the process.';
  }

  return error?.message || 'The server encountered an unexpected error. Action: Try a direct extraction format or a lower resolution.';
}

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
  });

  const PORT = 3000;

  app.use(express.json());

  // API Routes
  app.get("/api/search", async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: "Query required" });
    try {
      const searchResults = await ytSearch(q as string);
      const videos = searchResults.videos.slice(0, 20).map(v => ({
        type: 'video',
        id: v.videoId,
        url: v.url,
        title: v.title,
        bestThumbnail: { url: v.thumbnail || v.image },
        duration: v.timestamp || v.duration.toString(),
        author: { name: v.author.name },
        views: v.views
      }));
      res.json({ items: videos });
    } catch (error) {
      console.error("Search failed:", error);
      res.status(500).json({ error: "Search failed" });
    }
  });

  app.get("/api/info", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "URL required" });
    
    const videoIdMatch = (url as string).match(/(?:v=|\/|be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
    const videoId = videoIdMatch ? videoIdMatch[1] : null;

    try {
      // 1. Try RapidAPI First (Fastest for full stream extraction)
      if (videoId && process.env.RAPIDAPI_KEY) {
        console.log("Fetching info via RapidAPI (Primary):", videoId);
        const rapidInfo = await fetchFromRapidAPI(videoId);
        if (rapidInfo && rapidInfo.formats?.length > 0) {
          return res.json(rapidInfo);
        }
      }

      // 2. Parallel Metadata Race for Fallback
      // If RapidAPI or standard ytdl is slow/blocked, we want basic info FAST
      const metadataPromise = (async () => {
        if (!videoId) return null;
        try {
          const videoInfo = await ytSearch({ videoId });
          if (videoInfo) return {
            id: videoInfo.videoId,
            title: videoInfo.title,
            description: videoInfo.description,
            thumbnails: [{ url: videoInfo.thumbnail || videoInfo.image }],
            duration: videoInfo.seconds,
            author: { name: videoInfo.author.name },
            formats: [], 
            audioFormats: [],
            subtitles: []
          };
        } catch (e) {}
        return null;
      })();

      // 3. Try ytdl with a shorter initial timeout for metadata
      try {
        console.log("Fetching info via ytdl (Secondary):", url);
        const info = await ytdl.getInfo(url as string, {
          playerClients: ['ANDROID', 'IOS', 'WEB_EMBEDDED'],
          requestOptions: {
            headers: {
              "User-Agent": USER_AGENT,
              "Accept-Language": "en-US,en;q=0.9",
              "Referer": "https://www.youtube.com/"
            },
            timeout: 8000 // 8 second timeout for metadata
          } as any
        });

        const formats = ytdl.filterFormats(info.formats, "audioandvideo");
        const audioFormats = ytdl.filterFormats(info.formats, "audioonly");
        
        return res.json({
          id: info.videoDetails.videoId,
          title: info.videoDetails.title,
          description: info.videoDetails.description,
          thumbnails: info.videoDetails.thumbnails,
          duration: info.videoDetails.lengthSeconds,
          author: info.videoDetails.author,
          formats: formats.map(f => ({
            quality: f.qualityLabel,
            container: f.container,
            url: f.url,
            hasVideo: f.hasVideo,
            hasAudio: f.hasAudio,
            itag: f.itag,
            size: f.contentLength
          })),
          audioFormats: audioFormats.map(f => ({
            quality: f.audioBitrate,
            container: f.container,
            url: f.url,
            hasVideo: f.hasVideo,
            hasAudio: f.hasAudio,
            itag: f.itag,
            size: f.contentLength
          })),
          subtitles: info.player_response.captions?.playerCaptionsTracklistRenderer?.captionTracks || []
        });
      } catch (ytdlError: any) {
        console.warn("ytdl fallback failed, waiting for metadata race...", ytdlError?.message);
        
        const fastMeta = await metadataPromise;
        if (fastMeta) return res.json(fastMeta);
        
        throw ytdlError;
      }
    } catch (error: any) {
      console.error("Info error:", error);
      res.status(500).json({ 
        error: "Failed to extract video information. Please try a different link.",
        details: error.message 
      });
    }
  });

  app.get("/api/subtitles", async (req, res) => {
    const { url, lang, title } = req.query;
    if (!url) return res.status(400).send("Subtitle URL required");
    try {
      const response = await fetch(url as string);
      const text = await response.text();
      const safeTitle = (title as string || "subtitles").replace(/[\\/:*?"<>|]/g, "_");
      res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.${lang}.vtt"`);
      res.setHeader("Content-Type", "text/vtt");
      res.send(text);
    } catch (error) {
      console.error("Subtitle error:", error);
      res.status(500).send("Failed to download subtitles");
    }
  });

  // Download stream proxy (to avoid CORS issues and handle conversion)
  app.get("/api/download", async (req, res) => {
    const { url, itag, format, title, socketId, downloadId } = req.query;
    if (!url) return res.status(400).send("URL required");

    const decodedTitle = decodeURIComponent(title as string || "video");
    const safeTitle = decodedTitle.replace(/[\\/:*?"<>|]/g, "_");
    const sid = socketId as string;
    const did = downloadId as string;

    const requestOptions = {
      // @ts-ignore - Distube version options
      playerClients: ['ANDROID', 'IOS', 'WEB_EMBEDDED'],
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.youtube.com/",
        "Origin": "https://www.youtube.com"
      }
    };

    const isDirectLink = (url as string).includes('googlevideo.com') || 
                         (!(url as string).includes('youtube.com') && !(url as string).includes('youtu.be'));

    if (isDirectLink) {
        // Direct Proxy Fallback for Piped/Invidious/RapidAPI direct stream links or googlevideo.com
        try {
          console.log("Proxying likely direct link:", url);
          const response = await fetch(url as string, {
            headers: {
               "User-Agent": USER_AGENT,
               "Referer": "https://www.youtube.com/"
            }
          });
          
          if (!response.ok) {
            console.error(`Proxy fetch failed with status ${response.status} for URL: ${url}`);
            // If it failed and it's NOT a googlevideo link, it's a real failure
            if (!(url as string).includes('googlevideo.com')) {
              throw new Error(`Proxy source returned HTTP ${response.status}`);
            }
            // If it WAS a googlevideo link, maybe it's expired/IP-locked, try ytdl as fallback
            console.warn("Googlevideo proxy failed, falling through to ytdl...");
          } else {
            const contentType = response.headers.get("content-type");
            if (contentType) res.setHeader("Content-Type", contentType);
            
            const contentLength = response.headers.get("content-length");
            if (contentLength) res.setHeader("Content-Length", contentLength);

            res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.${format || 'mp4'}"`);
            
            if (!response.body) throw new Error("No response body from proxy source");
            const nodeReadable = Readable.fromWeb(response.body as any);
            
            // Basic progress tracking for proxied streams
            if (sid && did && contentLength) {
              const total = parseInt(contentLength);
              let downloaded = 0;
              let lastEmit = 0;
              nodeReadable.on('data', (chunk) => {
                downloaded += chunk.length;
                const now = Date.now();
                if (now - lastEmit > 1000) {
                  const percent = Math.floor((downloaded / total) * 100);
                  io.to(sid).emit("downloadProgress", { id: did, progress: percent, downloaded, total });
                  lastEmit = now;
                }
              });
            }

            nodeReadable.pipe(res);
            return;
          }
        } catch (proxyError: any) {
          console.error("Proxy download failed:", proxyError);
          // Only throw if it's not a youtube/googlevideo link that we could try to re-extract
          if (!(url as string).includes('googlevideo.com') && !(url as string).includes('youtube.com')) {
             return res.status(500).send(`Download failed: ${proxyError.message || proxyError}`);
          }
        }
    }

    // 1. If it's a YouTube Watch URL (not already a direct link), try to get a fresh RapidAPI link first
    const videoIdMatch = (url as string).match(/(?:v=|\/|be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
    if (videoIdMatch && !isDirectLink) {
      const videoId = videoIdMatch[1];
      console.log("YouTube Watch URL detected in download, fetching fresh direct link via RapidAPI:", videoId);
      try {
        const rapidInfo = await fetchFromRapidAPI(videoId);
        if (rapidInfo) {
          let targetFormat;
          if (format === "mp3") {
            targetFormat = rapidInfo.audioFormats?.[0] || rapidInfo.formats?.find(f => f.hasAudio);
          } else {
            targetFormat = rapidInfo.formats?.find(f => f.itag === itag) || rapidInfo.formats?.[0];
          }

          if (targetFormat?.url) {
            console.log("Fresh RapidAPI direct link obtained, redirecting to proxy...");
            return res.redirect(`/api/download?url=${encodeURIComponent(targetFormat.url)}&format=${format || targetFormat.container}&title=${encodeURIComponent(decodedTitle)}&socketId=${sid}&downloadId=${did}`);
          }
        }
      } catch (rapidErr) {
        console.warn("RapidAPI fresh link fetch failed, falling back to ytdl:", rapidErr);
      }
    }

    try {
      if (format === "mp3") {
        res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.mp3"`);
        res.setHeader("Content-Type", "audio/mpeg");
        
        let stream;
        try {
          stream = ytdl(url as string, {
            quality: "highestaudio",
            // @ts-ignore
            playerClients: ['ANDROID', 'IOS', 'WEB_EMBEDDED'],
            requestOptions
          });
        } catch (err: any) {
          throw err;
        }

        if (sid && did) {
          let lastEmit = 0;
          stream.on("progress", (_, downloaded, total) => {
            const now = Date.now();
            if (now - lastEmit > 500) { // Throttle emissions
              const percent = Math.floor((downloaded / total) * 100);
              io.to(sid).emit("downloadProgress", { 
                id: did, 
                progress: percent,
                downloaded,
                total
              });
              lastEmit = now;
            }
          });
        }

        ffmpeg(stream)
          .audioBitrate(128)
          .format("mp3")
          .on("error", (err) => {
            console.error("FFMPEG error:", err);
            if (sid && did) io.to(sid).emit("downloadError", { 
              id: did, 
              error: "Audio conversion failed. " + getFriendlyErrorMessage(err) 
            });
          })
          .pipe(res);
      } else {
        const quality = itag && itag !== '' ? parseInt(itag as string) : "highestvideo";
        
        let info;
        try {
          info = await ytdl.getInfo(url as string, { 
            // @ts-ignore
            playerClients: ['ANDROID', 'IOS', 'WEB_EMBEDDED'],
            requestOptions 
          });
        } catch (err: any) {
           throw err;
        }

        const formatInfo = ytdl.chooseFormat(info.formats, { quality });
        
        res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.${formatInfo.container}"`);
        res.setHeader("Content-Type", `video/${formatInfo.container}`);
        
        const stream = ytdl(url as string, { 
          quality, 
          // @ts-ignore
          playerClients: ['ANDROID', 'IOS', 'WEB_EMBEDDED'],
          requestOptions 
        });

        if (sid && did) {
          let lastEmit = 0;
          stream.on("progress", (_, downloaded, total) => {
            const now = Date.now();
            if (now - lastEmit > 500) {
              const percent = Math.floor((downloaded / total) * 100);
              io.to(sid).emit("downloadProgress", { 
                id: did, 
                progress: percent,
                downloaded,
                total
              });
              lastEmit = now;
            }
          });
        }

        stream.pipe(res);
      }
    } catch (error: any) {
      console.error("Download error:", error);
      const friendlyMsg = getFriendlyErrorMessage(error);
      if (sid && did) {
        io.to(sid).emit("downloadError", { id: did, error: friendlyMsg });
      }
      res.status(500).send(friendlyMsg);
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
