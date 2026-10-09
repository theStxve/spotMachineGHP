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
      const cleanTime = String(rawTime || "").split("[")[0].trim();
      const ts = Date.parse(cleanTime);
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
    if (qLower.length >= 3 && /[a-z0-9]/i.test(qLower)) {
      queryCounts.set(qLower, (queryCounts.get(qLower) || 0) + 1);
    }
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
    for (const item of topQueries.slice(0, 60)) {
      if (item.count >= 2 && !knownArtists.has(item.query) && !knownTracks.has(item.query)) {
        ghostSearches.push(item);
      }
    }
  } else {
    const zeroClickCounts = new Map();
    for (let i = 0; i < cleaned.length; i++) {
      const s = cleaned[i];
      if (!s.has_interaction) {
        const ql = s.query.toLowerCase().trim();
        if (ql.length >= 3 && /[a-z0-9]/i.test(ql)) {
          zeroClickCounts.set(ql, (zeroClickCounts.get(ql) || 0) + 1);
        }
      }
    }
    const zeroClickSorted = Array.from(zeroClickCounts.entries())
      .map(([query, count]) => ({ query, count }))
      .sort((a, b) => b.count - a.count);
    for (const item of zeroClickSorted) {
      if (item.count >= 2) {
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
    recent_searches: cleaned,
    date_range: cleaned.length > 0 ? {
      start: cleaned[cleaned.length - 1].time,
      end: cleaned[0].time,
      days_count: new Set(cleaned.map(s => s.time.split(" ")[0])).size
    } : null,
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
    displayName: userdata.displayName || userdata.username || "Spotify User",
    username: userdata.username || "Spotify User",
    country: userdata.country || "DE",
    creation_time: userdata.creationTime || "",
    birthdate: userdata.birthdate || "",
    gender: userdata.gender || "",
    postal_code: userdata.postalCode || "",
    imageUrl: userdata.largeImageUrl || userdata.imageUrl || "",
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

    // Map URIs aus Frame falls vorhanden
    const uriMap = new Map();
    if (frame && frame.has && (frame.has("uri") || frame.has("spotify_track_uri"))) {
      const uCol = frame.has("spotify_track_uri") ? frame.col("spotify_track_uri").data : frame.col("uri").data;
      for (let i = 0; i < songIds.length; i++) {
        if (uCol[i] && !uriMap.has(songIds[i])) {
          uriMap.set(songIds[i], uCol[i]);
        }
      }
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
          uri: it.uri || uriMap.get(sid) || "",
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
          uri: uriMap.get(sid) || "",
          streams: cnt,
        });
      }
    }
    ghostHits.sort((a, b) => b.streams - a.streams);
  } else {
    for (let i = 0; i < Math.min(tracks.length, 100); i++) {
      const it = tracks[i];
      graveyard.push({
        artist: it.artist,
        track: it.track,
        album: it.album,
        uri: it.uri || "",
        streams: 0,
        status: "In Bibliothek",
      });
    }
  }

  const topArtists = Array.from(artistCounts.entries())
    .map(([artist, count]) => ({ artist, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  return {
    loaded: true,
    tracks_count: tracks.length,
    albums_count: albums.length,
    shows_count: showsRaw.length,
    graveyard_count: graveyard.length,
    graveyard_tracks: graveyard.slice(0, 100),
    ghost_hits: ghostHits.slice(0, 50),
    top_library_artists: topArtists,
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


export function analyzeFollow(follow, userdata) {
  let followers = [];
  let following = [];
  let blocked = [];
  if (follow && typeof follow === "object") {
    followers = follow.userIsFollowedBy || follow.followers || follow.followerList || [];
    following = follow.userIsFollowing || follow.following || follow.followingList || [];
    blocked = follow.userIsBlocking || follow.blockedUsers || follow.blockedList || [];
  }

  const hasFollow = Boolean(followers.length || following.length || blocked.length);
  const hasUser = Boolean(userdata && typeof userdata === "object" && Object.keys(userdata).length > 0);

  if (!hasFollow && !hasUser) return { loaded: false };

  const setFollowers = new Set(followers);
  const mutual = following.filter(u => setFollowers.has(u)).sort();

  const userInfo = hasUser ? {
    displayName: userdata.displayName || userdata.username || "Spotify User",
    username: userdata.username || "",
    country: userdata.country || "DE",
    creationTime: userdata.creationTime || "",
    birthdate: userdata.birthdate || "",
    gender: userdata.gender || "",
    imageUrl: userdata.largeImageUrl || userdata.imageUrl || "",
    tasteMaker: Boolean(userdata.tasteMaker),
    email: userdata.email || "",
  } : {};

  return {
    loaded: true,
    followers_count: followers.length,
    following_count: following.length,
    blocked_count: blocked.length,
    mutual_count: mutual.length,
    followers,
    following,
    mutual,
    blocked,
    user_info: userInfo,
  };
}

export function analyzeMarquee(marquee) {
  if (!marquee || !Array.isArray(marquee) || !marquee.length) return { loaded: false };

  const segmentsMap = new Map();
  const artistsBySegment = new Map();
  const cleaned = [];

  for (let i = 0; i < marquee.length; i++) {
    const item = marquee[i];
    const artist = String(item.artistName || "").trim();
    const segment = String(item.segment || "Sonstige").trim();
    if (!artist) continue;

    segmentsMap.set(segment, (segmentsMap.get(segment) || 0) + 1);
    if (!artistsBySegment.has(segment)) artistsBySegment.set(segment, []);
    artistsBySegment.get(segment).push(artist);
    cleaned.push({ artist, segment });
  }

  const total = cleaned.length;
  const order = ["Super Listeners", "Moderate listeners", "Light listeners", "Previously Active Listeners"];
  const segmentStats = [];
  const seen = new Set();

  for (const s of order) {
    if (segmentsMap.has(s)) {
      seen.add(s);
      const count = segmentsMap.get(s);
      segmentStats.push({
        segment: s,
        count,
        percentage: Math.round((count / total) * 1000) / 10,
        sample_artists: (artistsBySegment.get(s) || []).slice(0, 30).sort(),
      });
    }
  }

  for (const [s, count] of segmentsMap.entries()) {
    if (!seen.has(s)) {
      segmentStats.push({
        segment: s,
        count,
        percentage: Math.round((count / total) * 1000) / 10,
        sample_artists: (artistsBySegment.get(s) || []).slice(0, 30).sort(),
      });
    }
  }

  return {
    loaded: true,
    total_artists: total,
    segments: segmentStats,
    super_listeners: (artistsBySegment.get("Super Listeners") || []).sort(),
    super_count: (artistsBySegment.get("Super Listeners") || []).length,
    moderate_count: (artistsBySegment.get("Moderate listeners") || []).length,
    light_count: (artistsBySegment.get("Light listeners") || []).length,
    inactive_count: (artistsBySegment.get("Previously Active Listeners") || []).length,
    all_artists: cleaned.slice(0, 2000),
  };
}

export function analyzeWrapped(wrappedData) {
  if (!wrappedData || typeof wrappedData !== "object" || !Object.keys(wrappedData).length) {
    return { loaded: false };
  }

  const metrics = wrappedData.yearlyMetrics || {};
  const totalMs = Number(metrics.totalMsListened) || 0;
  const totalMinutes = Math.round((totalMs / 60000) * 10) / 10;
  const totalHours = Math.round((totalMs / 3600000) * 10) / 10;

  const listeningAge = wrappedData.listeningAge || {};
  const clubs = wrappedData.clubs || {};
  const party = wrappedData.party || {};

  const tempo = party.weightedMsAvgTempo;
  const avgTempo = tempo != null ? Math.round(Number(tempo) * 10) / 10 : null;

  const popularity = party.avgTrackPopularityScore;
  const avgPop = popularity != null ? Math.round(Number(popularity) * 1000) / 10 : null;

  const shares = party.numSharesAllContent || 0;
  const topTracks = (wrappedData.topTracks && wrappedData.topTracks.topTracks) || [];
  const uniqueTracks = (wrappedData.topTracks && wrappedData.topTracks.numUniqueTracks) || 0;

  const clubName = String(clubs.userClub || "").replace(/_/g, " ");
  const clubRole = String(clubs.role || "");

  return {
    loaded: true,
    total_minutes: totalMinutes,
    total_hours: totalHours,
    listening_age: listeningAge.listeningAge || null,
    window_start_year: listeningAge.windowStartYear || null,
    user_club: clubName || "Musik-Club",
    club_role: clubRole || "Mitglied",
    club_percent: clubs.percentInClub ? Math.round(Number(clubs.percentInClub) * 1000) / 10 : null,
    avg_tempo_bpm: avgTempo,
    avg_popularity: avgPop,
    shares_count: shares,
    top_tracks_count: topTracks.length,
    unique_tracks: uniqueTracks,
    top_fan: (wrappedData.topFanLeaderboard && wrappedData.topFanLeaderboard.ownUserStats) || {},
  };
}

export function analyzePurchases(purchases) {
  if (!purchases || !Array.isArray(purchases) || !purchases.length) return { loaded: false };

  let totalSpent = 0;
  let currency = "USD";
  const itemsList = [];
  const ordersList = [];

  for (let i = 0; i < purchases.length; i++) {
    const p = purchases[i];
    const priceSet = p.currentTotalPriceSet || {};
    const amt = parseFloat(priceSet.amount) || 0;
    const curr = priceSet.currencyCode || "USD";
    currency = curr;
    totalSpent += amt;
    const created = String(p.createdAt || "").slice(0, 10);
    const status = String(p.displayFulfillmentStatus || "Fulfilled");

    const lines = [];
    const lineItems = Array.isArray(p.lineItems) ? p.lineItems : [];
    for (let j = 0; j < lineItems.length; j++) {
      const it = lineItems[j];
      const title = it.title || it.name || "Merch Item";
      const itAmt = parseFloat(it.originalTotalSet && it.originalTotalSet.amount) || 0;
      const shipping = Math.round(Math.max(0, amt - itAmt) * 100) / 100;
      lines.push({ title, amount: itAmt });
      itemsList.push({
        title,
        amount: itAmt,
        currency: curr,
        date: created,
        order_total: amt,
        shipping,
      });
    }

    const orderId = String(p.id || "").split("/").pop();
    ordersList.push({
      id: orderId,
      date: created,
      amount: Math.round(amt * 100) / 100,
      currency: curr,
      status,
      items: lines,
    });
  }

  let subtotalItems = 0;
  for (let i = 0; i < itemsList.length; i++) subtotalItems += itemsList[i].amount;
  subtotalItems = Math.round(subtotalItems * 100) / 100;
  const totalShipping = Math.round(Math.max(0, totalSpent - subtotalItems) * 100) / 100;

  return {
    loaded: true,
    total_spent: Math.round(totalSpent * 100) / 100,
    subtotal_items: subtotalItems,
    total_shipping: totalShipping,
    currency,
    orders_count: ordersList.length,
    items_count: itemsList.length,
    items: itemsList,
    orders: ordersList,
  };
}
