import React, { useState, useEffect, useRef } from 'react';
import { 
  Search as SearchIcon, 
  Download as DownloadIcon, 
  Library, 
  Settings as SettingsIcon, 
  Play, 
  CheckCircle, 
  Clock, 
  MoreVertical,
  X,
  Music,
  Video,
  ExternalLink,
  History,
  AlertCircle,
  Zap,
  Loader2,
  Check
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { db, auth, googleProvider } from './firebase';
import { signInWithPopup, onAuthStateChanged, User } from 'firebase/auth';
import { collection, addDoc, query, where, onSnapshot, orderBy, Timestamp } from 'firebase/firestore';
import { io, Socket } from 'socket.io-client';

// Types
interface VideoResult {
  type: string;
  title: string;
  id: string;
  url: string;
  bestThumbnail: { url: string };
  duration: string;
  author: { name: string };
  views: number;
}

interface PlaylistItem {
  id: string;
  title: string;
  thumbnail: string;
  url: string;
  duration: string;
  author: string;
}

interface Playlist {
  id: string;
  name: string;
  userId: string;
  items: PlaylistItem[];
  timestamp: any;
}

interface DownloadJob {
  id: string;
  title: string;
  status: 'active' | 'completed' | 'paused' | 'failed';
  progress: number;
  format: string;
  quality: string;
  itag?: string;
  url: string;
  thumbnail: string;
  timestamp: any;
  downloaded?: number;
  total?: number;
  eta?: string;
  speed?: string;
  subtitles?: any[];
  isOffline?: boolean;
  blobUrl?: string;
  errorMessage?: string;
  retryCount?: number;
  isRetrying?: boolean;
  nextRetryIn?: number;
}

// IndexedDB Helper for Offline Storage
const DB_NAME = 'MediaFlowOffline';
const STORE_NAME = 'media';

const initDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const saveToOffline = async (id: string, blob: Blob) => {
  const db = await initDB();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(blob, id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

const getFromOffline = async (id: string): Promise<Blob | null> => {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    return null;
  }
};

const deleteFromOffline = async (id: string) => {
  const db = await initDB();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export default function App() {
  const [activeTab, setActiveTab] = useState('search');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<VideoResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState<any>(null);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [playingMedia, setPlayingMedia] = useState<DownloadJob | null>(null);
  const [selectedSubtitle, setSelectedSubtitle] = useState<string | null>(null);
  const [showInterstitial, setShowInterstitial] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [downloads, setDownloads] = useState<DownloadJob[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [activeDownloads, setActiveDownloads] = useState<Record<string, Partial<DownloadJob>>>({});
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [showPlaylistSelector, setShowPlaylistSelector] = useState(false);
  const [saveOffline, setSaveOffline] = useState(() => {
    const saved = localStorage.getItem('saveOffline');
    return saved !== null ? JSON.parse(saved) : true;
  });

  useEffect(() => {
    localStorage.setItem('saveOffline', JSON.stringify(saveOffline));
  }, [saveOffline]);
  const [downloadingItags, setDownloadingItags] = useState<Record<string, boolean>>({});
  const [downloadTypeTab, setDownloadTypeTab] = useState<'video' | 'audio'>('video');
  const socketRef = useRef<Socket | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const createPlaylist = async (name: string) => {
    if (!user || !name.trim()) return;
    try {
      await addDoc(collection(db, 'playlists'), {
        name,
        userId: user.uid,
        items: [],
        timestamp: Timestamp.now()
      });
    } catch (e) {
      console.error(e);
      alert("Failed to create playlist");
    }
  };

  const addToPlaylist = async (playlistId: string, item: any) => {
    if (!user) return;
    const playlist = playlists.find(p => p.id === playlistId);
    if (!playlist) return;

    // Check if already in playlist
    if (playlist.items.some(i => i.id === item.id)) {
      alert("Already in playlist");
      return;
    }

    try {
      const { updateDoc, doc } = await import('firebase/firestore');
      const playlistRef = doc(db, 'playlists', playlistId);
      await updateDoc(playlistRef, {
        items: [...playlist.items, {
          id: item.id,
          title: item.title,
          thumbnail: item.thumbnail || item.bestThumbnail?.url,
          url: item.url,
          duration: item.duration,
          author: item.author?.name || item.author
        }]
      });
      alert(`Added to ${playlist.name}`);
      setShowPlaylistSelector(false);
    } catch (e) {
      console.error(e);
      alert("Failed to add to playlist");
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
    });
    
    socketRef.current = io();
    
    socketRef.current.on('downloadProgress', (data) => {
      setActiveDownloads(prev => {
        const job = prev[data.id] || {};
        const startTime = (job as any).startTime || Date.now();
        const downloaded = data.downloaded;
        const total = data.total;
        const elapsed = (Date.now() - startTime) / 1000;
        const speedBytes = downloaded / elapsed; // bytes per second
        const remaining = total - downloaded;
        const etaSeconds = remaining / speedBytes;
        
        let eta = '...';
        if (etaSeconds < 60) eta = `${Math.round(etaSeconds)}s`;
        else eta = `${Math.round(etaSeconds / 60)}m`;

        const formatSpeed = (bytes: number) => {
          if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB/s`;
          return `${(bytes / 1024).toFixed(1)} KB/s`;
        };
        
        const speed = formatSpeed(speedBytes);

        return {
          ...prev,
          [data.id]: {
            ...job,
            progress: data.progress,
            downloaded,
            total,
            eta,
            speed,
            status: data.progress === 100 ? 'completed' : 'active',
            startTime
          }
        };
      });
    });

    socketRef.current.on('downloadError', (data) => {
      setActiveDownloads(prev => {
        const currentJob = prev[data.id];
        if (!currentJob) return prev;

        const currentRetryCount = currentJob.retryCount || 0;
        const maxRetries = 3;

        if (currentRetryCount < maxRetries) {
          const nextRetryCount = currentRetryCount + 1;
          
          // Exponential backoff: 1min, 2min, 5min
          const backoffSeconds = nextRetryCount === 1 ? 60 : nextRetryCount === 2 ? 120 : 300;
          let secondsLeft = backoffSeconds;

          // Clear any existing timer for this job if it exists (safety)
          if ((currentJob as any).timerId) clearInterval((currentJob as any).timerId);

          const timerId = setInterval(() => {
            secondsLeft -= 1;
            setActiveDownloads(state => {
              if (!state[data.id] || state[data.id].status !== 'failed' || (state[data.id] as any).timerId !== timerId) {
                clearInterval(timerId);
                return state;
              }
              return {
                ...state,
                [data.id]: { ...state[data.id], nextRetryIn: secondsLeft }
              };
            });

            if (secondsLeft <= 0) {
              clearInterval(timerId);
              // Trigger the actual retry
              retryDownload({ ...currentJob, id: data.id, retryCount: nextRetryCount } as DownloadJob);
            }
          }, 1000);

          return {
            ...prev,
            [data.id]: { 
              ...currentJob, 
              status: 'failed', 
              errorMessage: `${data.error || 'Download failed'}. Retrying with increased delay...`,
              retryCount: nextRetryCount,
              isRetrying: true,
              nextRetryIn: backoffSeconds,
              timerId: timerId as any
            }
          };
        }

        return {
          ...prev,
          [data.id]: { 
            ...currentJob, 
            status: 'failed', 
            isRetrying: false,
            errorMessage: `${data.error || 'Download failed'}. All ${maxRetries} retry attempts failed.`
          }
        };
      });
    });

    return () => {
      unsubscribe();
      socketRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (user) {
      const q = query(
        collection(db, 'downloads'),
        where('userId', '==', user.uid),
        orderBy('timestamp', 'desc')
      );
      const unsubscribe = onSnapshot(q, (snapshot) => {
        const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as DownloadJob));
        setDownloads(docs);
      });

      const qPlaylists = query(
        collection(db, 'playlists'),
        where('userId', '==', user.uid),
        orderBy('timestamp', 'desc')
      );
      const unsubscribePlaylists = onSnapshot(qPlaylists, (snapshot) => {
        const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Playlist));
        setPlaylists(docs);
      });

      return () => {
        unsubscribe();
        unsubscribePlaylists();
      };
    }
  }, [user]);

  const extractVideoId = (url: string) => {
    // Standard URL, Short URL, Embed URL, and Mobile URL support
    const regExp = /^.*((youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=)|youtube.com\/shorts\/)([^#&?]*).*/;
    const match = url.match(regExp);
    const id = (match && match[3].length === 11) ? match[3] : null;
    if (id) return id;
    
    // Fallback for simple ID pasting
    if (url.length === 11 && /^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
    return null;
  };

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const queryStr = searchQuery.trim();
    if (!queryStr) return;
    
    setLoading(true);
    setSearchResults([]); // Clear previous results immediately
    
    try {
      // Improved URL detection
      const videoId = extractVideoId(queryStr);
      const isUrl = videoId || queryStr.includes('youtube.com/') || queryStr.includes('youtu.be/');
      
      if (isUrl) {
        const finalUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : queryStr;
        console.log("Fetching info for:", finalUrl);
        
        const infoRes = await fetch(`/api/info?url=${encodeURIComponent(finalUrl)}`);
        const info = await infoRes.json();
        
        if (!info || info.error) {
          throw new Error(info.error || "Could not fetch video info. The link might be invalid or restricted.");
        }

        setSelectedVideo({
          id: videoId || info.id,
          url: finalUrl,
          title: info.title || 'Untitled Video',
          bestThumbnail: (info.thumbnails && info.thumbnails.length > 0) ? info.thumbnails[0] : { url: 'https://placehold.co/600x400?text=No+Thumbnail' },
          duration: info.duration,
          author: info.author,
          formats: info.formats || [],
          audioFormats: info.audioFormats || [],
          subtitles: info.subtitles || []
        });
        setShowDownloadModal(true);
        setLoading(false);
        return;
      }

      const res = await fetch(`/api/search?q=${encodeURIComponent(queryStr)}`);
      if (!res.ok) throw new Error("Search failed");
      const data = await res.json();
      setSearchResults(data.items || []);
    } catch (err: any) {
      console.error("Search/Info Error:", err);
      alert(err.message || "Something went wrong. Please check your connection.");
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async (format: string, itag: any, quality: string, directUrl?: string, videoOverride?: any) => {
    const video = videoOverride || selectedVideo;
    if (!video) return;
    
    // Set loading for this specific itag
    const loadingKey = itag || 'auto';
    setDownloadingItags(prev => ({ ...prev, [loadingKey]: true }));
    
    const downloadId = videoOverride?.id || Math.random().toString(36).substring(7);
    const socketId = socketRef.current?.id;

    // Prefer using the main video URL for server-side extraction unless we have a specific direct link from a fallback
    // If it's a googlevideo.com link, those are IP-locked and likely won't work proxied unless generated by our server
    const useDirect = directUrl && !directUrl.includes('googlevideo.com');
    const finalUrl = useDirect ? directUrl : (video.shortUrl || video.url || `https://youtube.com/watch?v=${video.id}`);
    
    const downloadUrl = `/api/download?url=${encodeURIComponent(finalUrl)}&itag=${itag || ''}&format=${format}&title=${encodeURIComponent(video.title)}&socketId=${socketId}&downloadId=${downloadId}`;
    
    // Track locally
    setActiveDownloads(prev => ({
      ...prev,
      [downloadId]: {
        id: downloadId,
        title: video.title,
        status: 'active',
        progress: 0,
        format,
        quality,
        thumbnail: video.bestThumbnail?.url || '',
        startTime: Date.now(),
        url: finalUrl,
        itag,
        retryCount: video.retryCount || 0
      }
    }));

    // Create record in Firestore if logged in
    try {
      if (user) {
        await addDoc(collection(db, 'downloads'), {
          userId: user.uid,
          title: video.title,
          status: 'completed',
          progress: 100,
          format,
          quality,
          itag,
          url: video.url,
          thumbnail: video.bestThumbnail?.url || '',
          timestamp: Timestamp.now(),
          isOffline: saveOffline
        });
      }
    } catch (e) {
       console.warn("Firestore download record failed", e);
    }

    setShowDownloadModal(false);

    if (saveOffline) {
       // Perform client-side fetch to store blob
       try {
         const response = await fetch(downloadUrl);
         if (!response.ok) {
           const errData = await response.text();
           throw new Error(errData || "Offline fetch failed");
         }
         
         const blob = await response.blob();
         await saveToOffline(downloadId, blob);
         
         // Trigger browser download to device storage from the blob
         const localUrl = URL.createObjectURL(blob);
         const a = document.createElement('a');
         a.href = localUrl;
         a.download = `${video.title}.${format}`;
         document.body.appendChild(a);
         a.click();
         document.body.removeChild(a);
         setTimeout(() => URL.revokeObjectURL(localUrl), 100);
         
         // Update status to completed locally if fetch is done
         setActiveDownloads(prev => ({
           ...prev,
           [downloadId]: { ...prev[downloadId], status: 'completed', progress: 100 }
         }));
       } catch (err: any) {
         console.error("Offline save failed:", err);
         setActiveDownloads(prev => ({
           ...prev,
           [downloadId]: { 
             ...prev[downloadId], 
             status: 'failed', 
             errorMessage: err.message
           }
         }));
       }
    } else {
      // Standard browser download
      window.location.assign(downloadUrl);
    }

    
    setDownloadingItags(prev => ({ ...prev, [loadingKey]: false }));

    // Show interstitial ad after 1 second
    setTimeout(() => {
      setShowInterstitial(true);
    }, 1000);
  };

  const retryDownload = async (dl: DownloadJob) => {
    // Construct video data from job info
    const videoData = {
      id: extractVideoId(dl.url),
      url: dl.url,
      title: dl.title,
      bestThumbnail: { url: dl.thumbnail },
      formats: [], 
      audioFormats: []
    };
    
    // Clear old active download and any pending timers
    setActiveDownloads(prev => {
      const job = prev[dl.id];
      if (job && (job as any).timerId) {
        clearInterval((job as any).timerId);
      }
      const next = { ...prev };
      delete next[dl.id];
      return next;
    });

    // Re-trigger with override to skip state sync delay
    handleDownload(dl.format, dl.itag, dl.quality, undefined, { ...videoData, retryCount: dl.retryCount });
  };

  const login = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: any) {
      console.error(err);
      if (err.code === 'auth/unauthorized-domain') {
        alert('This domain is not authorized in Firebase. Please add the current URL to "Authorized domains" in your Firebase Auth settings.');
      } else {
        alert('Login failed: ' + err.message);
      }
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white font-sans pb-20 selection:bg-red-500/30">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-slate-950/80 backdrop-blur-md border-b border-slate-800 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-red-600 rounded-lg flex items-center justify-center">
            <DownloadIcon size={18} className="text-white" />
          </div>
          <h1 className="text-xl font-bold tracking-tight">MediaFlow</h1>
        </div>
        <div>
          {user ? (
            <img src={user.photoURL || undefined} alt="avatar" className="w-8 h-8 rounded-full border border-slate-700" />
          ) : (
            <button onClick={login} className="text-xs bg-slate-800 px-3 py-1.5 rounded-full font-medium hover:bg-slate-700 transition-colors">
              Login
            </button>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="p-4 max-w-2xl mx-auto">
        <AnimatePresence mode="wait">
          {activeTab === 'search' && (
            <motion.div 
              key="search"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-6"
            >
              <form onSubmit={handleSearch} className="relative group">
                <input 
                  type="text" 
                  placeholder="Paste link or search..." 
                  className="w-full bg-slate-900 border border-slate-800 rounded-2xl py-4 pl-12 pr-4 focus:outline-none focus:ring-2 focus:ring-red-500/50 transition-all placeholder:text-slate-500"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                <SearchIcon className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-red-500 transition-colors" size={20} />
                <button type="submit" className="absolute right-3 top-1/2 -translate-y-1/2 bg-red-600 text-white px-4 py-1.5 rounded-xl text-sm font-bold shadow-lg shadow-red-600/20 active:scale-95 transition-transform">
                  Go
                </button>
              </form>

              {loading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-4">
                  <div className="w-10 h-10 border-4 border-red-500 border-t-transparent rounded-full animate-spin"></div>
                  <p className="text-slate-400 font-medium">Fetching media...</p>
                </div>
              ) : searchResults.length > 0 ? (
                <div className="space-y-4">
                  {searchResults.map((item) => (
                    <motion.div 
                      key={item.id}
                      initial={{ opacity: 0 }}
                      whileInView={{ opacity: 1 }}
                      viewport={{ once: true }}
                      className="bg-slate-900/50 border border-slate-800/50 rounded-2xl overflow-hidden flex gap-3 p-2 hover:bg-slate-900 transition-colors"
                      onClick={async () => {
                        setLoading(true);
                        try {
                          const res = await fetch(`/api/info?url=${encodeURIComponent(item.url)}`);
                          const info = await res.json();
                          if (info.error) {
                            alert("Failed to load video details.");
                          } else {
                            setSelectedVideo({ ...item, formats: info.formats, audioFormats: info.audioFormats, subtitles: info.subtitles });
                            setShowDownloadModal(true);
                          }
                        } catch (e) {
                          alert("Error connecting to server.");
                        } finally {
                          setLoading(false);
                        }
                      }}
                    >
                      <div className="relative flex-shrink-0 w-32 h-20 bg-slate-800 rounded-lg overflow-hidden">
                        {item.bestThumbnail?.url && <img src={item.bestThumbnail.url} alt="" className="w-full h-full object-cover" />}
                        <span className="absolute bottom-1 right-1 bg-black/80 text-[10px] px-1.5 py-0.5 rounded font-mono">
                          {item.duration}
                        </span>
                      </div>
                      <div className="flex flex-col justify-between py-1 overflow-hidden">
                        <div>
                          <h3 className="font-medium text-sm line-clamp-2 leading-snug">{item.title}</h3>
                          <p className="text-xs text-slate-400 mt-1">{item.author?.name}</p>
                        </div>
                        <div className="flex items-center gap-1 text-[10px] text-slate-500">
                          <Clock size={10} />
                          <span>{item.views || 0} views</span>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-20 text-center opacity-50">
                  <div className="w-20 h-20 bg-slate-900 rounded-full flex items-center justify-center mb-4">
                    <Library size={40} />
                  </div>
                  <h3 className="text-lg font-medium">No results yet</h3>
                  <p className="text-sm max-w-[200px]">Search for videos or paste a YouTube link to start</p>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'downloads' && (
            <motion.div 
              key="downloads"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-6"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-2xl font-bold">Download Manager</h2>
                <div className="bg-slate-900 p-1 rounded-xl flex gap-1">
                  <button className="px-3 py-1 rounded-lg bg-slate-800 text-xs font-bold">All</button>
                  <button className="px-3 py-1 rounded-lg text-xs text-slate-400">History</button>
                </div>
              </div>

              <AdBanner />

              {/* Active Downloads Section */}
              {Object.values(activeDownloads).length > 0 && (
                <div className="space-y-4">
                  <h3 className="text-xs uppercase font-bold text-slate-500 tracking-widest pl-2">Active</h3>
                  {Object.values(activeDownloads).map((item) => {
                    const dl = item as DownloadJob;
                    const formatBytes = (bytes?: number) => {
                      if (!bytes) return '0B';
                      if (bytes > 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
                      if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
                      return `${(bytes / 1024).toFixed(1)}KB`;
                    };

                    return (
                      <div key={dl.id} className={`bg-slate-900 border ${dl.status === 'failed' ? 'border-red-500' : 'border-red-500/20'} rounded-[28px] p-5 flex gap-5 ring-1 ring-red-500/10 shadow-2xl relative overflow-hidden`}>
                        {dl.status === 'active' && (
                          <motion.div 
                            initial={{ x: '-100%' }}
                            animate={{ x: '200%' }}
                            transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                            className="absolute top-0 left-0 w-1/2 h-[1px] bg-gradient-to-r from-transparent via-red-500/40 to-transparent opacity-50"
                          />
                        )}
                        <div className="w-24 h-16 bg-slate-800 rounded-2xl overflow-hidden flex-shrink-0 relative border border-slate-700/50">
                          {dl.thumbnail && <img src={dl.thumbnail} alt="" className="w-full h-full object-cover opacity-40" />}
                          <div className="absolute inset-0 flex items-center justify-center">
                            {dl.status === 'failed' ? (
                              <AlertCircle size={24} className="text-red-500" />
                            ) : (
                              <div className="w-8 h-8 border-[3px] border-red-500 border-t-transparent rounded-full animate-spin" />
                            )}
                          </div>
                        </div>
                        <div className="flex-1 min-w-0 flex flex-col justify-between">
                          <div className="flex justify-between items-start">
                            <div className="min-w-0">
                              <h3 className="text-sm font-bold truncate pr-2">{dl.title}</h3>
                              <div className="flex items-center gap-2 mt-1">
                                <span className="bg-red-600/10 text-red-500 text-[8px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider">{dl.format}</span>
                                <span className="text-[10px] text-slate-500 font-medium">{dl.quality}</span>
                                {dl.speed && dl.status === 'active' && <span className="text-[10px] text-red-500/80 font-mono italic">{dl.speed}</span>}
                                {dl.status === 'failed' && (
                                  <span className="text-[10px] text-red-500 font-bold flex items-center gap-1">
                                    <AlertCircle size={10} /> {dl.isRetrying ? `RETRYING (${dl.retryCount}/3)` : 'FAILED'}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex flex-col items-end">
                               <span className={`text-sm font-black italic ${dl.status === 'failed' ? 'text-red-500' : 'text-white'}`}>
                                 {dl.status === 'failed' ? (dl.isRetrying ? 'RETRYING' : 'ERROR') : `${dl.progress}%`}
                               </span>
                               {dl.status === 'active' && <span className="text-[9px] text-slate-500 font-mono uppercase tracking-tighter">ETA: {dl.eta}</span>}
                               {dl.status === 'failed' && dl.isRetrying && (
                                 <span className="text-[9px] text-red-400 font-mono uppercase animate-pulse">In {dl.nextRetryIn}s</span>
                               )}
                            </div>
                          </div>
                          
                          {dl.status === 'failed' && dl.errorMessage && (
                            <div className="text-[10px] text-red-400 mt-2 bg-red-500/5 p-3 rounded-xl border border-red-500/10 leading-relaxed shadow-inner">
                              {dl.errorMessage.includes('Action:') ? (
                                <>
                                  <p className="mb-1">{dl.errorMessage.split('Action:')[0]}</p>
                                  <p className="font-bold text-red-500 bg-red-500/10 -mx-1 px-1 rounded inline-block">
                                    <Zap size={8} className="inline mr-1" />
                                    Action: {dl.errorMessage.split('Action:')[1]}
                                  </p>
                                </>
                              ) : (
                                dl.errorMessage
                              )}
                            </div>
                          )}

                          <div className="mt-4">
                            {dl.status !== 'failed' ? (
                              <div className="h-2.5 w-full bg-slate-800/80 rounded-full overflow-hidden p-[2px] shadow-inner">
                                <motion.div 
                                  initial={{ width: 0 }}
                                  animate={{ width: `${dl.progress}%` }}
                                  className="h-full bg-gradient-to-r from-red-700 via-red-600 to-red-500 rounded-full relative overflow-hidden"
                                >
                                  <motion.div 
                                    animate={{ x: ['-100%', '100%'] }}
                                    transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
                                    className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent w-full"
                                  />
                                </motion.div>
                              </div>
                            ) : (
                               <div className="h-[1px] w-full bg-red-500/20" />
                            )}
                            
                            <div className="flex justify-between items-center text-[9px] mt-2 font-mono">
                              <span className="text-slate-500 uppercase tracking-tighter">
                                {dl.status === 'failed' ? 'Operation aborted' : `${formatBytes(dl.downloaded)} / ${formatBytes(dl.total)}`}
                              </span>
                              <div className="flex gap-3">
                                {dl.status === 'failed' ? (
                                  <>
                                    <button 
                                      onClick={() => retryDownload(dl)}
                                      className="font-black uppercase tracking-widest text-green-500 flex items-center gap-1 hover:scale-105 transition-transform"
                                    >
                                      <Zap size={10} /> Retry
                                    </button>
                                    <button 
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setActiveDownloads(prev => {
                                          const next = { ...prev };
                                          delete next[dl.id];
                                          return next;
                                        });
                                      }}
                                      className="text-slate-600 hover:text-white transition-colors"
                                    >
                                      DISMISS
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    <button 
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setActiveDownloads(prev => ({
                                          ...prev,
                                          [dl.id]: { ...prev[dl.id], status: prev[dl.id].status === 'paused' ? 'active' : 'paused' }
                                        }));
                                      }}
                                      className={`font-black uppercase tracking-widest transition-colors ${dl.status === 'paused' ? 'text-green-500' : 'text-red-500'}`}
                                    >
                                      {dl.status === 'paused' ? 'Resume' : 'Pause'}
                                    </button>
                                    <button 
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setActiveDownloads(prev => {
                                          const next = { ...prev };
                                          delete next[dl.id];
                                          return next;
                                        });
                                      }}
                                      className="text-slate-600 hover:text-white transition-colors"
                                    >
                                      CANCEL
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="space-y-4 pt-4">
                <h3 className="text-xs uppercase font-bold text-slate-500 tracking-widest pl-2">Finished History</h3>
                {downloads.length > 0 ? (
                  downloads.map((dl) => (
                    <div 
                      key={dl.id} 
                      className="bg-slate-900/50 border border-slate-800 rounded-2xl p-4 flex gap-4 opacity-80 hover:opacity-100 transition-opacity cursor-pointer hover:border-red-500/30"
                      onClick={async () => {
                        const cached = await getFromOffline(dl.id);
                        if (cached) {
                           setPlayingMedia({ ...dl, blobUrl: URL.createObjectURL(cached) });
                        } else {
                           setPlayingMedia(dl);
                        }
                      }}
                    >
                      <div className="w-20 h-14 bg-slate-800 rounded-lg overflow-hidden flex-shrink-0 relative group">
                        {dl.thumbnail && <img src={dl.thumbnail} alt="" className="w-full h-full object-cover" />}
                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                          <Play size={20} className="text-white" />
                        </div>
                        {dl.isOffline && (
                          <div className="absolute top-1 left-1 bg-green-500 rounded-full p-0.5 shadow-lg">
                            <CheckCircle size={8} className="text-white" />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-start">
                          <h3 className="text-sm font-medium line-clamp-1">{dl.title}</h3>
                          <span className="text-[10px] uppercase font-bold text-slate-500 ml-2">{dl.format}</span>
                        </div>
                        <div className="mt-2 flex justify-between items-center text-[10px] text-slate-400">
                          <span className="flex items-center gap-1">
                            {dl.status === 'completed' ? <CheckCircle size={10} className="text-green-500" /> : <Clock size={10} />}
                            {dl.status}
                          </span>
                          <div className="flex gap-2">
                             {dl.isOffline && (
                                <button 
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    const cached = await getFromOffline(dl.id);
                                    if (cached) {
                                      const url = URL.createObjectURL(cached);
                                      const a = document.createElement('a');
                                      a.href = url;
                                      a.download = `${dl.title || 'video'}.${dl.format || 'mp4'}`;
                                      document.body.appendChild(a);
                                      a.click();
                                      document.body.removeChild(a);
                                      URL.revokeObjectURL(url);
                                    }
                                  }}
                                  className="text-slate-400 hover:text-white transition-colors"
                                  title="Save to Device"
                                >
                                  <DownloadIcon size={14} />
                                </button>
                              )}
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedVideo(dl);
                                setShowPlaylistSelector(true);
                              }}
                              className="text-red-500 hover:text-red-400 font-bold"
                            >
                              + Playlist
                            </button>
                            <span>{dl.quality}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                ) : Object.values(activeDownloads).length === 0 && (
                  <div className="text-center py-20 opacity-30">
                    <DownloadIcon size={48} className="mx-auto mb-4" />
                    <p>No download history</p>
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {activeTab === 'library' && (
             <motion.div 
              key="library"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-6"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-2xl font-bold">Library</h2>
                <button 
                  onClick={() => {
                    const name = prompt("Enter playlist name:");
                    if (name) createPlaylist(name);
                  }}
                  className="bg-red-600/10 text-red-500 p-2 rounded-xl border border-red-500/20 active:scale-95 transition-transform"
                >
                  <Music size={20} />
                </button>
              </div>

              {selectedPlaylist ? (
                <div className="space-y-4">
                  <button 
                    onClick={() => setSelectedPlaylist(null)}
                    className="text-xs font-bold text-slate-500 flex items-center gap-1 hover:text-slate-300"
                  >
                    <X size={14} /> Back to Playlists
                  </button>
                  <div className="bg-slate-900/30 rounded-[32px] p-6 border border-slate-800">
                    <div className="flex gap-4 items-center mb-6">
                      <div className="w-24 h-24 bg-red-600 rounded-2xl flex items-center justify-center shadow-lg shadow-red-600/20">
                        <Music size={40} className="text-white" />
                      </div>
                      <div>
                        <h3 className="text-xl font-bold">{selectedPlaylist.name}</h3>
                        <p className="text-xs text-slate-500 mt-1">{selectedPlaylist.items.length} videos</p>
                      </div>
                    </div>
                    <div className="space-y-3">
                      {selectedPlaylist.items.map((item) => (
                        <div 
                          key={item.id}
                          onClick={async () => {
                            const cached = await getFromOffline(item.id);
                            const mediaItem = { ...item, format: 'mp4', status: 'completed' } as any;
                            if (cached) {
                              setPlayingMedia({ ...mediaItem, blobUrl: URL.createObjectURL(cached) });
                            } else {
                              setPlayingMedia(mediaItem);
                            }
                          }}
                          className="flex gap-3 items-center p-2 hover:bg-slate-800/50 rounded-xl transition-colors cursor-pointer group"
                        >
                          <div className="w-20 h-12 bg-slate-800 rounded-lg overflow-hidden flex-shrink-0 relative">
                            {item.thumbnail && <img src={item.thumbnail} alt="" className="w-full h-full object-cover" />}
                            <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                              <Play size={16} fill="white" className="text-white" />
                            </div>
                          </div>
                          <div className="flex-1 min-w-0">
                            <h4 className="text-sm font-medium line-clamp-1">{item.title}</h4>
                            <p className="text-[10px] text-slate-500">{item.author} • {item.duration}</p>
                          </div>
                        </div>
                      ))}
                      {selectedPlaylist.items.length === 0 && (
                         <p className="text-center py-10 text-slate-500 text-sm italic">Playlist is empty</p>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  {playlists.map((playlist) => (
                    <motion.div 
                      key={playlist.id}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setSelectedPlaylist(playlist)}
                      className="bg-slate-900 border border-slate-800 rounded-[24px] p-4 flex flex-col items-center text-center cursor-pointer hover:bg-slate-800/50 transition-colors"
                    >
                      <div className="w-full aspect-square bg-slate-800 rounded-2xl mb-4 flex items-center justify-center overflow-hidden">
                        {playlist.items[0]?.thumbnail ? (
                          <img src={playlist.items[0].thumbnail} className="w-full h-full object-cover" />
                        ) : (
                          <Music size={32} className="text-slate-600" />
                        )}
                      </div>
                      <h4 className="text-sm font-bold line-clamp-1 w-full">{playlist.name}</h4>
                      <p className="text-[10px] text-slate-500 mt-0.5">{playlist.items.length} items</p>
                    </motion.div>
                  ))}
                  {playlists.length === 0 && (
                    <div className="col-span-2 py-20 text-center opacity-50">
                      <Library size={48} className="mx-auto mb-4" />
                      <p className="text-sm">No playlists yet. Create one!</p>
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'settings' && (
            <motion.div 
              key="settings"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-8"
            >
              <h2 className="text-2xl font-bold">Settings</h2>
              
              <div className="space-y-4">
                <div className="bg-slate-900 rounded-2xl p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-red-500/10 rounded-xl flex items-center justify-center text-red-500">
                      <DownloadIcon size={20} />
                    </div>
                    <div>
                      <h4 className="text-sm font-medium">Default Format</h4>
                      <p className="text-xs text-slate-500">Auto-select for quick download</p>
                    </div>
                  </div>
                  <select className="bg-slate-800 text-xs rounded-lg px-2 py-1 outline-none">
                    <option>MP4 (Best)</option>
                    <option>MP3 (Audio)</option>
                  </select>
                </div>

                <div className="bg-slate-900 rounded-2xl p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-purple-500/10 rounded-xl flex items-center justify-center text-purple-500">
                      <DownloadIcon size={20} />
                    </div>
                    <div>
                      <h4 className="text-sm font-medium">Notifications</h4>
                      <p className="text-xs text-slate-500">Stay updated on new downloads</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => {
                      if ("Notification" in window) {
                        Notification.requestPermission().then(permission => {
                          alert(permission === 'granted' ? 'Notifications enabled!' : 'Permission denied');
                        });
                      }
                    }}
                    className="bg-slate-800 text-[10px] font-bold px-3 py-1.5 rounded-lg"
                  >
                    Enable
                  </button>
                </div>

                <div className="bg-slate-900 rounded-2xl p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-blue-500/10 rounded-xl flex items-center justify-center text-blue-500">
                      <History size={20} />
                    </div>
                    <div>
                      <h4 className="text-sm font-medium">Clear History</h4>
                      <p className="text-xs text-slate-500">Remove all download records</p>
                    </div>
                  </div>
                  <button className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Reset</button>
                </div>
              </div>

              {!user && (
                <button onClick={login} className="w-full bg-red-600 font-bold py-4 rounded-2xl shadow-xl shadow-red-600/20 active:scale-95 transition-all">
                  Sign in with Google
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Bottom Nav */}
      <nav className="fixed bottom-0 left-0 right-0 bg-slate-950/80 backdrop-blur-lg border-t border-slate-800 px-6 py-2 pb-6 flex justify-between items-center z-50">
        <NavButton active={activeTab === 'search'} icon={<SearchIcon />} onClick={() => setActiveTab('search')} label="Search" />
        <NavButton active={activeTab === 'downloads'} icon={<DownloadIcon />} onClick={() => setActiveTab('downloads')} label="Files" />
        <NavButton active={activeTab === 'library'} icon={<Library />} onClick={() => setActiveTab('library')} label="Library" />
        <NavButton active={activeTab === 'settings'} icon={<SettingsIcon />} onClick={() => setActiveTab('settings')} label="Menu" />
      </nav>

      {/* Media Player Modal */}
      <AnimatePresence>
        {playingMedia && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black z-[100] flex flex-col"
            >
              <div className="p-4 flex items-center justify-between bg-black/50 backdrop-blur-md sticky top-0 z-10">
                <button onClick={() => setPlayingMedia(null)} className="p-2 hover:bg-slate-800 rounded-full transition-colors">
                  <X size={24} />
                </button>
                <h3 className="text-sm font-bold truncate max-w-[70%]">{playingMedia.title}</h3>
                <div className="w-10" />
              </div>
              
              <div className="flex-1 flex items-center justify-center relative group">
                {playingMedia.format === 'mp3' ? (
                  <div className="flex flex-col items-center gap-8 w-full max-w-sm px-6">
                    <motion.div 
                      animate={{ 
                        scale: [1, 1.05, 1],
                        rotate: [0, 5, -5, 0]
                      }} 
                      transition={{ duration: 4, repeat: Infinity }}
                      className="w-64 h-64 rounded-3xl overflow-hidden shadow-2xl shadow-red-500/20"
                    >
                      {playingMedia.thumbnail && <img src={playingMedia.thumbnail} alt="" className="w-full h-full object-cover" />}
                    </motion.div>
                    <div className="text-center">
                      <h4 className="text-xl font-bold">{playingMedia.title}</h4>
                      <p className="text-slate-400 mt-2">Offline Audio Player</p>
                    </div>
                    <audio 
                      autoPlay 
                      controls 
                      className="w-full mt-4 invert"
                      src={`/api/download?url=${encodeURIComponent(playingMedia.url)}&format=${playingMedia.format}&title=${encodeURIComponent(playingMedia.title)}`}
                    />
                  </div>
                ) : (
                  <div className="w-full aspect-video md:max-w-4xl bg-slate-900 shadow-2xl">
                      <video 
                        key={playingMedia.blobUrl || playingMedia.id}
                        ref={videoRef}
                        autoPlay 
                        controls 
                        className="w-full h-full"
                        poster={playingMedia.thumbnail}
                        src={playingMedia.blobUrl || `/api/download?url=${encodeURIComponent(playingMedia.url)}&itag=${playingMedia.itag || ''}&format=${playingMedia.format}&title=${encodeURIComponent(playingMedia.title)}`}
                      >
                        {selectedSubtitle && (
                          <track 
                            label="Selected Language" 
                            kind="subtitles" 
                            srcLang="en" 
                            src={selectedSubtitle} 
                            default 
                          />
                        )}
                      </video>
                  </div>
                )}
              </div>
              
              <div className="p-8 bg-slate-950 border-t border-slate-800 text-center text-xs text-slate-500">
                Playing from local cache proxy
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Download Modal */}
      <AnimatePresence>
        {showDownloadModal && selectedVideo && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60]"
              onClick={() => setShowDownloadModal(false)}
            />
            <motion.div 
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="fixed bottom-0 left-0 right-0 bg-slate-900 rounded-t-[32px] z-[70] p-6 max-h-[90vh] overflow-y-auto border-t border-slate-800"
            >
              <div className="w-12 h-1 bg-slate-800 rounded-full mx-auto mb-6 opacity-50" />
              
              {/* Video Preview Section */}
              <div className="mb-6 rounded-2xl overflow-hidden aspect-video bg-black shadow-inner border border-slate-800">
                <iframe 
                  width="100%" 
                  height="100%" 
                  src={`https://www.youtube.com/embed/${selectedVideo.id}`} 
                  title="YouTube video player" 
                  frameBorder="0" 
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" 
                  allowFullScreen
                  className="rounded-2xl"
                />
              </div>

              <div className="flex gap-4 mb-8">
                {selectedVideo.bestThumbnail?.url && <img src={selectedVideo.bestThumbnail.url} alt="" className="w-32 h-20 object-cover rounded-xl border border-slate-800" />}
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-lg leading-tight line-clamp-2">{selectedVideo.title}</h3>
                  <p className="text-sm text-slate-400 mt-1">{selectedVideo.author?.name}</p>
                </div>
              </div>

              <div className="space-y-8">
                <div className="flex gap-2">
                  <button 
                    disabled={downloadingItags['auto']}
                    onClick={() => {
                      const bestFormat = selectedVideo.formats?.[0]; // Usually highest is first in my API responses
                      if (bestFormat) {
                        handleDownload(bestFormat.container || 'mp4', bestFormat.itag, bestFormat.quality, bestFormat.url);
                      } else {
                        // Fallback to searching formats if list not sorted
                        const highQuality = selectedVideo.formats?.find((f: any) => f.quality.includes('720') || f.quality.includes('1080')) || selectedVideo.formats?.[0];
                        if (highQuality) {
                          handleDownload(highQuality.container || 'mp4', highQuality.itag, highQuality.quality, highQuality.url);
                        } else {
                           alert("No suitable format found automatically. Please select one below.");
                        }
                      }
                    }}
                    className={`flex-1 ${downloadingItags['auto'] ? 'bg-slate-700 cursor-not-allowed' : 'bg-red-600 hover:bg-red-700 active:scale-95'} shadow-lg shadow-red-600/20 py-3 rounded-2xl font-bold flex items-center justify-center gap-2 transition-all`}
                  >
                    {downloadingItags['auto'] ? (
                      <Loader2 size={18} className="animate-spin text-white" />
                    ) : (
                      <DownloadIcon size={18} className="text-white" />
                    )}
                    {downloadingItags['auto'] ? 'Initializing...' : 'Download Best MP4'}
                  </button>
                  <button 
                    onClick={() => setShowPlaylistSelector(true)}
                    className="p-3 bg-slate-800 border border-slate-700 rounded-2xl hover:bg-slate-700 transition-colors"
                    title="Add to Playlist"
                  >
                    <Library size={18} className="text-slate-400" />
                  </button>
                </div>

                <div className="flex items-center justify-between bg-slate-900/50 p-5 rounded-3xl border border-slate-800 shadow-inner group">
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-colors ${saveOffline ? 'bg-green-500/10 text-green-500' : 'bg-slate-800 text-slate-500'}`}>
                      {saveOffline ? <Library size={24} /> : <DownloadIcon size={24} />}
                    </div>
                    <div>
                      <h4 className="text-sm font-black tracking-tight">{saveOffline ? 'Save to Offline Library' : 'Browser Download Only'}</h4>
                      <p className="text-[10px] text-slate-500 mt-0.5 max-w-[180px] leading-tight">
                        {saveOffline 
                          ? 'Stores media in IndexedDB for offline access within the app.' 
                          : 'Redirects to browser default download behavior.'}
                      </p>
                    </div>
                  </div>
                  <button 
                    onClick={() => setSaveOffline(!saveOffline)}
                    className={`w-14 h-7 rounded-full p-1.5 transition-all duration-300 relative ${saveOffline ? 'bg-green-600 shadow-lg shadow-green-600/20' : 'bg-slate-700'}`}
                  >
                    <motion.div 
                      layout
                      animate={{ x: saveOffline ? 28 : 0 }}
                      transition={{ type: "spring", stiffness: 500, damping: 30 }}
                      className="w-4 h-4 bg-white rounded-full shadow-md"
                    />
                  </button>
                </div>

                <div className="space-y-6">
                  {/* Tabs for Format Selection */}
                  <div className="flex p-1 bg-slate-800/50 rounded-2xl border border-slate-800/50">
                    <button 
                      onClick={() => setDownloadTypeTab('video')}
                      className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-black tracking-widest transition-all ${downloadTypeTab === 'video' ? 'bg-red-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                      <Video size={14} /> VIDEO
                    </button>
                    <button 
                      onClick={() => setDownloadTypeTab('audio')}
                      className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-black tracking-widest transition-all ${downloadTypeTab === 'audio' ? 'bg-red-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                      <Music size={14} /> AUDIO
                    </button>
                  </div>

                  {downloadTypeTab === 'video' ? (
                    <div>
                      <div className="grid grid-cols-1 gap-3 max-h-[350px] overflow-y-auto pr-1">
                        {selectedVideo.formats?.map((f: any) => (
                          <button 
                            key={f.itag}
                            disabled={downloadingItags[f.itag]}
                            onClick={() => handleDownload(f.container || 'mp4', f.itag, f.quality, f.url)}
                            className={`${downloadingItags[f.itag] ? 'bg-slate-800 opacity-70 cursor-not-allowed' : 'bg-slate-800/40 hover:bg-slate-800'} border border-slate-700/50 p-4 rounded-2xl flex items-center justify-between transition-all group relative overflow-hidden w-full`}
                          >
                            <div className="flex items-center gap-4">
                              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${f.container === 'webm' ? 'bg-amber-500/10 text-amber-500' : 'bg-blue-500/10 text-blue-500'}`}>
                                <span className="text-[10px] font-black uppercase">{f.container}</span>
                              </div>
                              <div className="text-left">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-black">{f.quality}</span>
                                  {f.hasAudio && <span className="text-[9px] bg-green-500/20 text-green-500 px-1.5 py-0.5 rounded font-bold">HD</span>}
                                  {f.size && (
                                    <span className="text-[10px] text-slate-400 opacity-60">
                                      {parseInt(f.size) > 1024 * 1024 
                                        ? `${(parseInt(f.size) / (1024 * 1024)).toFixed(1)} MB` 
                                        : `${(parseInt(f.size) / 1024).toFixed(0)} KB`}
                                    </span>
                                  )}
                                </div>
                                <div className="flex gap-2 items-center mt-0.5">
                                  <span className="text-[10px] text-slate-500">{f.hasAudio ? 'High Quality Video + Audio' : 'Video Only (Proxy Mute)'}</span>
                                </div>
                              </div>
                            </div>
                            
                            <div className="flex items-center gap-3">
                               {downloadingItags[f.itag] ? (
                                  <Loader2 size={18} className="text-red-500 animate-spin" />
                                ) : (
                                  <div className="w-8 h-8 rounded-full bg-red-600/10 flex items-center justify-center text-red-500 group-hover:bg-red-600 group-hover:text-white transition-all">
                                    <DownloadIcon size={14} />
                                  </div>
                                )}
                            </div>
                          </button>
                        ))}
                        {(!selectedVideo.formats || selectedVideo.formats.length === 0) && (
                          <div className="py-8 text-center text-slate-500 bg-slate-800/10 rounded-2xl border border-dashed border-slate-800">
                             <Video size={24} className="mx-auto mb-2 opacity-20" />
                             <p className="text-sm">No video formats detected</p>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="grid grid-cols-1 gap-3 max-h-[350px] overflow-y-auto pr-1">
                        {/* Native MP3 Conversion Option */}
                        <button 
                          disabled={downloadingItags['mp3-best']}
                          onClick={() => {
                            setDownloadingItags(prev => ({ ...prev, 'mp3-best': true }));
                            handleDownload('mp3', null, '320kbps').finally(() => {
                               setDownloadingItags(prev => ({ ...prev, 'mp3-best': false }));
                            });
                          }}
                          className={`${downloadingItags['mp3-best'] ? 'bg-slate-800 opacity-70' : 'bg-red-600/10 hover:bg-red-600/20'} border border-red-600/30 p-4 rounded-2xl flex items-center justify-between transition-all group relative overflow-hidden w-full`}
                        >
                          <div className="flex items-center gap-4">
                            <div className="w-10 h-10 bg-red-600/20 rounded-xl flex items-center justify-center text-red-500">
                              <Zap size={20} />
                            </div>
                            <div className="text-left">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-black text-red-500 italic">MP3 CONVERT</span>
                                <span className="text-[9px] bg-red-600/20 text-red-500 px-1.5 py-0.5 rounded font-bold uppercase">MP3</span>
                              </div>
                              <p className="text-[10px] text-slate-400">Converted Premium High-Res Audio</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                             {downloadingItags['mp3-best'] ? (
                                <Loader2 size={18} className="text-red-500 animate-spin" />
                              ) : (
                                <div className="w-8 h-8 rounded-full bg-red-600/20 flex items-center justify-center text-red-500 group-hover:bg-red-600 group-hover:text-white transition-all">
                                  <DownloadIcon size={14} />
                                </div>
                              )}
                          </div>
                        </button>

                        {/* Direct Streams */}
                        {selectedVideo.audioFormats?.map((f: any) => (
                          <button 
                            key={f.itag}
                            disabled={downloadingItags[f.itag]}
                            onClick={() => handleDownload(f.container || 'm4a', f.itag, f.quality, f.url)}
                            className={`${downloadingItags[f.itag] ? 'bg-slate-800 opacity-70' : 'bg-slate-800/40 hover:bg-slate-800'} border border-slate-700/50 p-4 rounded-2xl flex items-center justify-between transition-all group relative overflow-hidden w-full`}
                          >
                            <div className="flex items-center gap-4">
                              <div className="w-10 h-10 bg-slate-700/50 rounded-xl flex items-center justify-center text-slate-300">
                                <Music size={18} />
                              </div>
                              <div className="text-left">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-black">{f.quality}</span>
                                  <span className="text-[9px] bg-slate-900/60 px-1.5 py-0.5 rounded font-mono uppercase text-slate-400">{f.container || 'm4a'}</span>
                                  {f.size && (
                                    <span className="text-[10px] text-slate-400 opacity-60">
                                      {parseInt(f.size) > 1024 * 1024 
                                        ? `${(parseInt(f.size) / (1024 * 1024)).toFixed(1)} MB` 
                                        : `${(parseInt(f.size) / 1024).toFixed(0)} KB`}
                                    </span>
                                  )}
                                </div>
                                <span className="text-[10px] text-slate-500">Direct Extraction (No re-encoding)</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                               {downloadingItags[f.itag] ? (
                                  <Loader2 size={18} className="text-red-500 animate-spin" />
                                ) : (
                                  <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 group-hover:bg-red-600 group-hover:text-white transition-all">
                                    <DownloadIcon size={14} />
                                  </div>
                                )}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>


                {selectedVideo.subtitles && selectedVideo.subtitles.length > 0 && (
                  <div>
                    <h4 className="text-xs uppercase font-bold text-slate-500 tracking-widest mb-3 flex items-center gap-2">
                      <History size={14} /> Subtitles (VTT)
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {selectedVideo.subtitles.map((sub: any) => (
                        <button 
                          key={sub.baseUrl}
                          onClick={() => {
                            if (activeTab === 'downloads' || playingMedia) {
                              setSelectedSubtitle(sub.baseUrl);
                            } else {
                              window.location.href = `/api/subtitles?url=${encodeURIComponent(sub.baseUrl)}&lang=${sub.languageCode}&title=${encodeURIComponent(selectedVideo.title)}`;
                            }
                          }}
                          className={`px-3 py-1.5 rounded-full text-[10px] font-bold border transition-colors ${selectedSubtitle === sub.baseUrl ? 'bg-red-600 border-red-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}`}
                        >
                          {sub.name.simpleText}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <button 
                onClick={() => setShowDownloadModal(false)}
                className="mt-8 w-full py-4 text-sm font-bold text-slate-500 hover:text-white transition-colors"
              >
                Cancel
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showInterstitial && (
          <InterstitialAd onClose={() => setShowInterstitial(false)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showPlaylistSelector && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[150]"
              onClick={() => setShowPlaylistSelector(false)}
            />
            <motion.div 
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              className="fixed bottom-0 left-0 right-0 bg-slate-900 rounded-t-[32px] z-[160] p-6 max-h-[70vh] overflow-y-auto border-t border-slate-800"
            >
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-lg font-bold">Add to Playlist</h3>
                <button onClick={() => setShowPlaylistSelector(false)}><X size={24} /></button>
              </div>
              
              <div className="space-y-3">
                <button 
                  onClick={() => {
                    const name = prompt("Enter playlist name:");
                    if (name) createPlaylist(name);
                  }}
                  className="w-full bg-slate-800/50 border border-dashed border-slate-700 p-4 rounded-2xl flex items-center gap-3 text-slate-400 hover:text-white transition-colors"
                >
                  <div className="w-10 h-10 bg-slate-800 rounded-xl flex items-center justify-center">
                    <Music size={20} />
                  </div>
                  <span className="font-bold">Create New Playlist</span>
                </button>
                
                {playlists.map(p => (
                  <button 
                    key={p.id}
                    onClick={() => addToPlaylist(p.id, selectedVideo)}
                    className="w-full bg-slate-800/30 border border-slate-800 p-4 rounded-2xl flex items-center gap-3 hover:bg-slate-800 transition-colors text-left"
                  >
                    <div className="w-10 h-10 bg-red-600/10 rounded-xl flex items-center justify-center text-red-500">
                      <Music size={20} />
                    </div>
                    <div className="flex-1">
                      <div className="font-bold">{p.name}</div>
                      <div className="text-[10px] text-slate-500">{p.items.length} videos</div>
                    </div>
                  </button>
                ))}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function AdBanner() {
  return (
    <div className="w-full bg-slate-900 border border-slate-800 rounded-2xl p-4 flex items-center gap-4 relative overflow-hidden group cursor-pointer hover:border-red-500/30 transition-colors">
      <div className="absolute top-0 right-0 bg-red-600 text-[8px] font-bold px-2 py-0.5 rounded-bl-lg uppercase tracking-tighter">Sponsored</div>
      <div className="w-12 h-12 bg-red-500/10 rounded-xl flex items-center justify-center flex-shrink-0">
        <ExternalLink size={20} className="text-red-500" />
      </div>
      <div>
        <h4 className="text-sm font-bold">Premium High-Speed VPN</h4>
        <p className="text-[10px] text-slate-400">Download videos 10x faster with our secure proxy service. No logs, just speed.</p>
      </div>
      <div className="ml-auto">
        <div className="bg-red-600 px-3 py-1 rounded-lg text-[10px] font-bold">JOIN</div>
      </div>
    </div>
  );
}

function InterstitialAd({ onClose }: { onClose: () => void }) {
  const [timer, setTimer] = useState(5);

  useEffect(() => {
    if (timer > 0) {
      const t = setTimeout(() => setTimer(timer - 1), 1000);
      return () => clearTimeout(t);
    }
  }, [timer]);

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-slate-950 z-[200] flex flex-col items-center justify-center p-8 text-center"
    >
      <div className="max-w-xs space-y-6">
        <div className="w-24 h-24 bg-red-600/10 rounded-3xl mx-auto flex items-center justify-center border-2 border-red-600/20">
           <DownloadIcon size={48} className="text-red-600 animate-bounce" />
        </div>
        <div>
          <h2 className="text-2xl font-black italic tracking-tighter">PREMIUM UNLOCKED?</h2>
          <p className="text-slate-400 text-sm mt-2">Get unlimited high-speed downloads, 4K resolution support, and zero ads for just $1.99/mo.</p>
        </div>
        
        <div className="grid gap-3">
          <button className="bg-red-600 py-4 rounded-2xl font-black tracking-wide shadow-xl shadow-red-600/30 active:scale-95 transition-transform">
            UPGRADE NOW
          </button>
          
          <button 
            onClick={timer === 0 ? onClose : undefined}
            disabled={timer > 0}
            className={`py-2 text-[10px] uppercase font-bold tracking-widest transition-opacity ${timer > 0 ? 'opacity-30' : 'opacity-60 hover:opacity-100'}`}
          >
            {timer > 0 ? `Skip in ${timer}s` : 'Skip and continue'}
          </button>
        </div>
      </div>
      
      <div className="absolute bottom-12 text-[10px] text-slate-600 font-mono">
        ADVERTISEMENT CONTENT • SUPPORT THE DEVELOPER
      </div>
    </motion.div>
  );
}

function NavButton({ active, icon, onClick, label }: { active: boolean, icon: any, onClick: () => void, label: string }) {
  return (
    <button 
      onClick={onClick}
      className={`flex flex-col items-center gap-1 transition-all duration-300 ${active ? 'text-red-500' : 'text-slate-500 hover:text-slate-300'}`}
    >
      <div className={`p-1 rounded-xl transition-all ${active ? 'bg-red-500/10 scale-110' : ''}`}>
        {React.cloneElement(icon, { size: 24, strokeWidth: active ? 2.5 : 2 })}
      </div>
      <span className="text-[10px] font-bold tracking-tight">{label}</span>
    </button>
  );
}
