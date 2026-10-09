/**
 * account.js - Analyse der Spotify-Kontodaten (SearchQueries, Inferences, Library, Playlists, Payments)
 * im Browser ohne Server.
 */

export function analyzeSearches(searches, frame) {
  if (!searches || !Array.isArray(searches) || !searches.length) {
    return { loaded: false };
  }

  const queryCounts = new Map();
  const platformCounts = new Map();
  const hourCounts = new Array(24).fill(0);
  const weekdayCounts = new Array(7).fill(0);
  const monthCounts = new Map();
  const cleaned = [];

  // Streaming Frame für Geister-Suchen
  const knownArtists = new Set();
  const knownTracks = new Set();
  if (frame && frame.has && frame.has("artist") && frame.has("track")) {
    const arts = frame.col("artist").data;
    const trks = frame.col("track").data;
    for (let i = 0; i < arts.length; i++) {
      if (arts[i]) knownArtists.add(String(arts[i]).toLowerCase().trim());
      if (trks[i]) knownTracks.add(String(trks[i]).toLowerCase().trim());
    }
  }

  for (let i = 0; i < searches.length; i++) {
    const item = searches[i];
    const q = String(item.searchQuery || "").trim();
    if (!q) continue;

    const rawTime = item.searchTime || item.search_time || item.timestamp;
    const platform = String(item.platform || "Unbekannt").trim();
    const uris = item.searchInteractionURIs || [];
    const hasInteraction = Array.isArray(uris) ? uris.length > 0 : Boolean(uris);

    let parsedDt = null;
    if (rawTime) {
      const ts = Date.parse(rawTime);
      if (Number.isFinite(ts)) {
        parsedDt = new Date(ts);
        const hr = parsedDt.getUTCHours();
        const wd = (parsedDt.getUTCDay() + 6) % 7; // 0=Mo ... 6=So
        hourCounts[hr] = (hourCounts[hr] || 0) + 1;
        weekdayCounts[wd] = (weekdayCounts[wd] || 0) + 1;
        const ym = parsedDt.getUTCFullYear() + "-" + String(parsedDt.getUTCMonth() + 1).padStart(2, "0");
        monthCounts.set(ym, (monthCounts.get(ym) || 0) + 1);
      }
    }

    const qLower = q.toLowerCase();
    queryCounts.set(qLower, (queryCounts.get(qLower) || 0) + 1);
    platformCounts.set(platform, (platformCounts.get(platform) || 0) + 1);

    const fmtTime = parsedDt
      ? String(parsedDt.getUTCDate()).padStart(2, "0") + "." +
        String(parsedDt.getUTCMonth() + 1).padStart(2, "0") + "." +
        parsedDt.getUTCFullYear() + " " +
        String(parsedDt.getUTCHours()).padStart(2, "0") + ":" +
        String(parsedDt.getUTCMinutes()).padStart(2, "0")
      : String(rawTime || "");

    cleaned.push({
      query: q,
      time: fmtTime,
      iso_time: parsedDt ? parsedDt.toISOString() : "",
      platform,
      has_interaction: hasInteraction,
      interactions_count: Array.isArray(uris) ? uris.length : (hasInteraction ? 1 : 0),
    });
  }

  cleaned.sort((a, b) => b.iso_time.localeCompare(a.iso_time));

  const totalSearches = cleaned.length;
  const uniqueQueries = queryCounts.size;
  const interactionRate = totalSearches > 0
    ? Math.round((cleaned.filter((s) => s.has_interaction).length / totalSearches) * 1000) / 10
    : 0;

  const topQueries = Array.from(queryCounts.entries())
    .map(([query, count]) => ({ query, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  const platforms = Array.from(platformCounts.entries())
    .map(([platform, count]) => ({ platform, count }))
    .sort((a, b) => b.count - a.count);

  const ghostSearches = [];
  if (knownArtists.size > 0 || knownTracks.size > 0) {
    for (const item of topQueries.slice(0, 50)) {
      if (item.count >= 2 && !knownArtists.has(item.query) && !knownTracks.has(item.query)) {
        ghostSearches.push(item);
      }
    }
  }

  const monthlyTrend = Array.from(monthCounts.entries())
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return {
    loaded: true,
    total_searches: totalSearches,
    unique_queries: uniqueQueries,
    interaction_rate: interactionRate,
    top_queries: topQueries,
    platforms,
    hour_counts: hourCounts,
    weekday_counts: weekdayCounts,
    weekday_labels: ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"],
    monthly_trend: monthlyTrend,
    ghost_searches: ghostSearches.slice(0, 15),
    recent_searches: cleaned.slice(0, 200),
  };
}


export function analyzeInferences(inferences, userdata) {
  const hasInferences = Array.isArray(inferences) && inferences.length > 0;
  const hasUser = userdata && typeof userdata === "object" && Object.keys(userdata).length > 0;

  if (!hasInferences && !hasUser) {
    return { loaded: false };
  }

  const cleaned = [];
  const categoriesMap = new Map();

  for (const item of inferences || []) {
    const tag = String(item || "").trim();
    if (!tag) continue;
    cleaned.push(tag);
    const low = tag.toLowerCase();

    let catName = "Allgemeine Segmente";
    if (low.includes("1p_custom") || low.includes("custom")) {
      catName = "Custom Audiences & Algorithmus";
    } else if (low.includes("culture") || low.includes("lifestyle")) {
      catName = "Kultur & Lifestyle";
    } else if (/rock|pop|hiphop|rap|indie|electronic|metal|jazz|classical/i.test(low)) {
      catName = "Musikgenres & Audio-Geschmack";
    } else if (low.includes("receptive") || low.includes("intent") || low.includes("shopper")) {
      catName = "Kauf- & Hörabsichten";
    } else if (/commuter|gym|morning|night|gamer/i.test(low)) {
      catName = "Aktivitäten & Gewohnheiten";
    }

    if (!categoriesMap.has(catName)) categoriesMap.set(catName, []);
    categoriesMap.get(catName).push(tag);
  }

  const categories = Array.from(categoriesMap.entries()).map(([cat, tags]) => ({
    category: cat,
    count: tags.length,
    tags: tags.sort(),
  })).sort((a, b) => b.count - a.count);

  const userInfo = hasUser ? {
    username: userdata.username || "Spotify User",
    country: userdata.country || "DE",
    creation_time: userdata.creationTime || "",
    birthdate: userdata.birthdate || "",
    gender: userdata.gender || "",
    postal_code: userdata.postalCode || "",
  } : {};

  return {
    loaded: true,
    total_inferences: cleaned.length,
    tags: cleaned.sort(),
    categories,
    user_info: userInfo,
  };
}


export function analyzeLibrary(library, frame) {
  if (!library || typeof library !== "object") {
    return { loaded: false };
  }

  const tracksRaw = Array.isArray(library.tracks) ? library.tracks : [];
  const albumsRaw = Array.isArray(library.albums) ? library.albums : [];
  const showsRaw = Array.isArray(library.shows) ? library.shows : [];

  if (!tracksRaw.length && !albumsRaw.length && !showsRaw.length) {
    return { loaded: false };
  }

  const tracks = [];
  const artistCounts = new Map();

  for (const t of tracksRaw) {
    const artist = String(t.artist || "").trim();
    const track = String(t.track || "").trim();
    const album = String(t.album || "").trim();
    if (!track) continue;
    artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1);
    tracks.push({ artist, track, album, uri: t.uri || "" });
  }

  const albums = [];
  for (const a of albumsRaw) {
    const artist = String(a.artist || "").trim();
    const album = String(a.album || "").trim();
    if (album) albums.push({ artist, album });
  }

  const graveyard = [];
  const ghostHits = [];

  if (frame && frame.has && frame.has("song_id")) {
    const songIds = frame.col("song_id").data;
    const playCounts = new Map();
    for (let i = 0; i < songIds.length; i++) {
      const sid = songIds[i];
      playCounts.set(sid, (playCounts.get(sid) || 0) + 1);
    }

    // Friedhof
    for (const it of tracks) {
      const sid = it.artist.toLowerCase().trim() + " — " + it.track.toLowerCase().trim();
      const cnt = playCounts.get(sid) || 0;
      if (cnt === 0 || cnt === 1) {
        graveyard.push({
          artist: it.artist,
          track: it.track,
          album: it.album,
          streams: cnt,
          status: cnt === 0 ? "Nie gehört" : "Nur 1x gehört",
        });
      }
    }

    // Geister-Hits: Meistgehörte Songs nicht in der Library
    const libSet = new Set(tracks.map((t) => t.artist.toLowerCase().trim() + " — " + t.track.toLowerCase().trim()));
    for (const [sid, cnt] of playCounts.entries()) {
      if (cnt >= 15 && !libSet.has(sid)) {
        const parts = sid.split(" — ");
        ghostHits.push({
          artist: parts[0] || "",
          track: parts[1] || "",
          streams: cnt,
        });
      }
    }
    ghostHits.sort((a, b) => b.streams - a.streams);
  }

  graveyard.sort((a, b) => a.streams - b.streams);

  return {
    loaded: true,
    tracks_count: tracks.length,
    albums_count: albums.length,
    shows_count: showsRaw.length,
    graveyard_count: graveyard.length,
    graveyard_tracks: graveyard.slice(0, 50),
    ghost_hits: ghostHits.slice(0, 30),
  };
}


export function analyzePlaylists(playlists, frame) {
  if (!playlists || !Array.isArray(playlists) || !playlists.length) {
    return { loaded: false };
  }

  const summary = [];
  const trackMap = new Map();
  let totalTracks = 0;

  for (const pl of playlists) {
    const name = String(pl.name || "Unbenannte Playlist").trim();
    const items = Array.isArray(pl.items) ? pl.items : [];
    totalTracks += items.length;

    const plArtists = new Map();
    for (const it of items) {
      const t = it.track || {};
      const tName = String(t.trackName || "").trim();
      const aName = String(t.artistName || "").trim();
      if (tName && aName) {
        plArtists.set(aName, (plArtists.get(aName) || 0) + 1);
        const key = aName + " — " + tName;
        if (!trackMap.has(key)) trackMap.set(key, []);
        trackMap.get(key).push(name);
      }
    }

    const topArt = Array.from(plArtists.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([art]) => art);

    summary.push({
      name,
      last_modified: pl.lastModifiedDate || "",
      track_count: items.length,
      followers: Number(pl.numberOfFollowers) || 0,
      top_artists: topArt,
    });
  }

  const duplicates = [];
  for (const [song, plList] of trackMap.entries()) {
    if (plList.length > 1) {
      duplicates.push({ song, count: plList.length, playlists: plList });
    }
  }
  duplicates.sort((a, b) => b.count - a.count);
  summary.sort((a, b) => b.track_count - a.track_count);

  return {
    loaded: true,
    total_playlists: playlists.length,
    total_tracks: totalTracks,
    playlists: summary,
    duplicates_count: duplicates.length,
    duplicates: duplicates.slice(0, 40),
  };
}


export function analyzePayments(payments, frame) {
  if (!payments || !Array.isArray(payments) || !payments.length) {
    return { loaded: false };
  }

  let totalSpent = 0;
  let currency = "EUR";
  const list = [];

  for (const p of payments) {
    const rawAmt = p.amount || p.total || 0;
    const amt = parseFloat(String(rawAmt).replace(",", ".")) || 0;
    totalSpent += amt;
    if (p.currency) currency = String(p.currency).toUpperCase();
    list.push({
      date: p.date || "",
      amount: Math.round(amt * 100) / 100,
      currency,
      method: p.paymentMethod || "Abo",
    });
  }

  let costPerHour = null;
  let costPerStream = null;

  if (frame && frame.has && frame.has("minutes_played")) {
    const mins = frame.col("minutes_played").data;
    let totalMins = 0;
    for (let i = 0; i < mins.length; i++) totalMins += mins[i];
    const totalHours = totalMins / 60;
    if (totalHours > 0) costPerHour = Math.round((totalSpent / totalHours) * 100) / 100;
    if (frame.n > 0) costPerStream = Math.round((totalSpent / frame.n) * 10000) / 100; // in Cent
  }

  return {
    loaded: true,
    total_spent: Math.round(totalSpent * 100) / 100,
    currency,
    payments_count: list.length,
    cost_per_hour: costPerHour,
    cost_per_stream_cents: costPerStream,
    payments: list.sort((a, b) => b.date.localeCompare(a.date)),
  };
}
