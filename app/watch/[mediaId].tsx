import React, { useCallback, useState, useEffect, useRef } from 'react';
import {
  AppState,
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  BackHandler,
  StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import {
  safeLockOrientation,
  safeSetImmersiveFullscreen,
  OrientationLock,
} from '../../src/utils/orientation';
import {
  fetchMovieDetails,
  fetchTVDetails,
  fetchTVSeason,
  providers,
} from '../../src/services/media-api';
import type { ProviderId } from '../../src/types/provider';
import { providerAdapters } from '../../src/services/cowatch/player-adapters';
import { colors } from '../../src/theme/colors';
import {
  buildResumableProviderUrl,
  NORMAL_PLAYER_PROGRESS_BRIDGE,
  parseNormalPlaybackMessage,
} from '../../src/features/progress/provider-progress';
import {
  getContinueWatching,
  isCompletedProgress,
  removeContinueWatching,
  upsertContinueWatching,
} from '../../src/features/progress/storage';
import type { ContinueWatchingRecord } from '../../src/features/progress/types';

const BLOCKED_EXTERNAL_SCHEMES = [
  'intent:',
  'market:',
  'mailto:',
  'tel:',
  'sms:',
  'whatsapp:',
  'tg:',
  'viber:',
  'fb:',
];

const getHostname = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const normalizeDomain = (value: string): string =>
  value
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');

const isSameOrSubdomain = (hostname: string, domain: string): boolean => {
  const normalizedHostname = hostname.toLowerCase().replace(/^www\./, '');
  const normalizedDomain = normalizeDomain(domain);

  return (
    normalizedHostname === normalizedDomain ||
    normalizedHostname.endsWith(`.${normalizedDomain}`)
  );
};

const shouldAllowPlayerNavigation = (
  url: string,
  providerDomain: string,
  adapterOrigin?: string,
): boolean => {
  if (!url) return false;

  const lowerUrl = url.toLowerCase();

  if (BLOCKED_EXTERNAL_SCHEMES.some((scheme) => lowerUrl.startsWith(scheme))) {
    return false;
  }

  if (!lowerUrl.startsWith('https://') && !lowerUrl.startsWith('http://')) {
    return false;
  }

  const hostname = getHostname(url);
  if (!hostname) return false;

  if (isSameOrSubdomain(hostname, providerDomain)) return true;

  if (adapterOrigin && isSameOrSubdomain(hostname, adapterOrigin)) return true;

  return false;
};

const PLAYER_SECURITY_BRIDGE = `
(function() {
  if (window.__lauratv_security_bridge_v3_installed) return true;
  window.__lauratv_security_bridge_v3_installed = true;

  function textOf(value) {
    try { return String(value || '').toLowerCase(); } catch (e) { return ''; }
  }

  function isBlockedExternalUrl(value) {
    var text = textOf(value);
    return /(^|[\s"'(])intent:|(^|[\s"'(])(market|mailto|tel|sms|whatsapp|tg|viber|fb):|pyppo\\.com|com\\.android\\.chrome/.test(text);
  }

  function isVideoOrControl(node) {
    if (!node || node.nodeType !== 1) return false;
    var tag = (node.tagName || '').toLowerCase();
    if (tag === 'video' || tag === 'audio' || tag === 'button') return true;
    if (node.getAttribute && node.getAttribute('role') === 'button') return true;
    var cls = textOf(node.className) + ' ' + textOf(node.id);
    return /(^|[\\s_-])(control|controls|play|pause|seek|progress|volume|fullscreen|player-control)([\\s_-]|$)/.test(cls);
  }

  function rectFor(node) {
    try { return node.getBoundingClientRect(); } catch (e) { return null; }
  }

  function coversMostPlayer(node) {
    var rect = rectFor(node);
    if (!rect) return false;
    var width = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
    var height = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
    if (!width || !height) return false;
    return rect.width >= width * 0.55 && rect.height >= height * 0.35;
  }

  function isOverlayCandidate(node) {
    if (!node || node.nodeType !== 1 || isVideoOrControl(node)) return false;
    var style;
    try { style = window.getComputedStyle(node); } catch (e) { return false; }
    var position = style.position || '';
    var z = parseInt(style.zIndex || '0', 10);
    var pointer = style.pointerEvents || '';
    if (pointer === 'none') return false;
    if (!(position === 'fixed' || position === 'absolute' || z >= 100)) return false;
    return coversMostPlayer(node);
  }

  function hideNode(node) {
    if (!node || node.nodeType !== 1 || isVideoOrControl(node)) return;
    try {
      node.style.setProperty('display', 'none', 'important');
      node.style.setProperty('visibility', 'hidden', 'important');
      node.style.setProperty('opacity', '0', 'important');
      node.style.setProperty('pointer-events', 'none', 'important');
    } catch (e) {}
  }

  function hideBlockedTarget(node) {
    if (!node || node.nodeType !== 1) return;
    var current = node;
    for (var i = 0; i < 8 && current; i += 1) {
      var value = '';
      try {
        value = current.href || current.src || current.action ||
          current.getAttribute('href') || current.getAttribute('src') ||
          current.getAttribute('onclick') || current.getAttribute('data-url') ||
          current.getAttribute('data-href') || '';
      } catch (e) {}
      if (isBlockedExternalUrl(value) || isOverlayCandidate(current)) {
        hideNode(current);
        return;
      }
      current = current.parentElement;
    }
  }

  function scrubKnownAdNodes(root) {
    if (!root || root.nodeType !== 1) return;
    var list = [];
    try {
      if (root.matches && root.matches('a,iframe,object,embed,[onclick],[onpointerdown],[ontouchstart]')) list.push(root);
      var found = root.querySelectorAll ? root.querySelectorAll('a,iframe,object,embed,[onclick],[onpointerdown],[ontouchstart]') : [];
      for (var i = 0; i < found.length; i += 1) list.push(found[i]);
    } catch (e) {}

    for (var j = 0; j < list.length; j += 1) {
      var node = list[j];
      var value = '';
      try {
        value = node.href || node.src || node.getAttribute('href') || node.getAttribute('src') ||
          node.getAttribute('onclick') || node.getAttribute('data-url') || node.getAttribute('data-href') || '';
      } catch (e) {}
      if (isBlockedExternalUrl(value)) hideBlockedTarget(node);
    }
  }

  function scrubLargeAdOverlays() {
    var all;
    try { all = document.querySelectorAll('*'); } catch (e) { return; }
    var video = null;
    try { video = document.querySelector('video'); } catch (e) {}

    for (var i = 0; i < all.length; i += 1) {
      var node = all[i];
      if (!isOverlayCandidate(node)) continue;
      if (video && node.contains && node.contains(video)) continue;

      var html = '';
      try { html = textOf(node.outerHTML).slice(0, 12000); } catch (e) {}
      if (isBlockedExternalUrl(html) || /(^|[\\s_-])(ad|ads|advert|advertisement|popup|popunder)([\\s_-]|$)/.test(html)) {
        hideNode(node);
      }
    }
  }

  try {
    window.open = function() { return null; };
  } catch (e) {}

  try {
    document.addEventListener('click', function(event) {
      var node = event.target;
      while (node && node !== document.body) {
        var value = '';
        try {
          value = node.href || node.src || node.getAttribute('href') || node.getAttribute('src') ||
            node.getAttribute('onclick') || node.getAttribute('data-url') || node.getAttribute('data-href') || '';
        } catch (e) {}
        if (isBlockedExternalUrl(value)) {
          event.preventDefault();
          event.stopPropagation();
          if (event.stopImmediatePropagation) event.stopImmediatePropagation();
          hideBlockedTarget(node);
          return;
        }
        if (node.tagName === 'A' && (node.target === '_blank' || node.target === '_new')) {
          event.preventDefault();
          event.stopPropagation();
          if (event.stopImmediatePropagation) event.stopImmediatePropagation();
          return;
        }
        node = node.parentElement;
      }
    }, true);
  } catch (e) {}

  function blockAdTouch(event) {
    var node = event.target;
    var blocked = false;
    while (node && node !== document.body) {
      var value = '';
      try {
        value = node.href || node.src || node.getAttribute('href') || node.getAttribute('src') ||
          node.getAttribute('onclick') || node.getAttribute('data-url') || node.getAttribute('data-href') || '';
      } catch (e) {}
      if (isBlockedExternalUrl(value)) {
        blocked = true;
        hideBlockedTarget(node);
        break;
      }
      node = node.parentElement;
    }

    if (blocked) {
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    }
  }

  try {
    document.addEventListener('pointerdown', blockAdTouch, true);
    document.addEventListener('touchstart', blockAdTouch, true);
    document.addEventListener('mousedown', blockAdTouch, true);
  } catch (e) {}

  try {
    scrubKnownAdNodes(document.documentElement);
    scrubLargeAdOverlays();

    var observer = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i += 1) {
        var mutation = mutations[i];
        for (var j = 0; j < mutation.addedNodes.length; j += 1) {
          var added = mutation.addedNodes[j];
          if (added && added.nodeType === 1) scrubKnownAdNodes(added);
        }
      }
      scrubLargeAdOverlays();
    });
    observer.observe(document.documentElement || document, { childList: true, subtree: true });

    setInterval(scrubLargeAdOverlays, 750);
  } catch (e) {}
})();
true;
`

export default function WatchScreen() {
  const router = useRouter();
  const { mediaId, type = 'movie', season, episode } = useLocalSearchParams<{
    mediaId: string;
    type?: string;
    season?: string;
    episode?: string;
  }>();

  const [activeProviderId, setActiveProviderId] = useState<ProviderId>(providers[0].id);
  const [webViewError, setWebViewError] = useState(false);
  const [webKey, setWebKey] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [historyReady, setHistoryReady] = useState(false);
  const [resumePositionSeconds, setResumePositionSeconds] = useState<number | undefined>();
  const isMountedRef = useRef(true);
  const playbackProgressRef = useRef<{ positionSeconds?: number; durationSeconds?: number }>({});
  const lastPersistedAtRef = useRef(0);
  const lastPersistedPositionRef = useRef<number | undefined>(undefined);
  const completedRef = useRef(false);
  const persistLatestRef = useRef<() => Promise<void>>(async () => {});

  const id = Number(mediaId);
  const mediaType = (type as 'movie' | 'tv') || 'movie';
  const parsedSeason = season !== undefined && season !== '' ? Number(season) : undefined;
  const parsedEpisode = episode !== undefined && episode !== '' ? Number(episode) : undefined;
  const seasonNum = parsedSeason !== undefined && Number.isInteger(parsedSeason) && parsedSeason >= 0
    ? parsedSeason
    : undefined;
  const episodeNum = parsedEpisode !== undefined && Number.isInteger(parsedEpisode) && parsedEpisode >= 1
    ? parsedEpisode
    : undefined;

  // Queries for title metadata
  const { data: movie } = useQuery({
    queryKey: ['movieDetails', id],
    queryFn: () => fetchMovieDetails(id),
    enabled: mediaType === 'movie' && !!id,
  });

  const { data: show } = useQuery({
    queryKey: ['tvDetails', id],
    queryFn: () => fetchTVDetails(id),
    enabled: mediaType === 'tv' && !!id,
  });

  const { data: seasonData } = useQuery({
    queryKey: ['tvSeason', id, seasonNum],
    queryFn: () => fetchTVSeason(id, seasonNum!),
    enabled: mediaType === 'tv' && !!id && seasonNum !== undefined && Number.isInteger(seasonNum) && seasonNum >= 0,
  });

  const currentEpisode = seasonData?.episodes?.find((ep) => ep.episode_number === episodeNum);

  const title = mediaType === 'movie' ? movie?.title || 'Movie' : show?.name || 'TV Show';
  const subtitle =
    mediaType === 'tv' && episodeNum !== undefined
      ? `S${seasonNum} E${episodeNum}${currentEpisode?.name ? ` · ${currentEpisode.name}` : ''}`
      : null;

  const currentProvider = providers.find((p) => p.id === activeProviderId) || providers[0];
  const baseEmbedUrl = currentProvider.getUrl(id, mediaType, seasonNum, episodeNum);
  const embedUrl = buildResumableProviderUrl(
    baseEmbedUrl,
    activeProviderId,
    resumePositionSeconds,
  );

  useEffect(() => {
    let active = true;
    completedRef.current = false;
    setHistoryReady(false);
    setResumePositionSeconds(undefined);
    playbackProgressRef.current = {};

    void getContinueWatching().then((records) => {
      if (!active) return;
      const exactRecord = records.find(
        (record) =>
          record.mediaId === id &&
          record.mediaType === mediaType &&
          record.season === seasonNum &&
          record.episode === episodeNum,
      );
      if (exactRecord) {
        setResumePositionSeconds(exactRecord.positionSeconds);
        setActiveProviderId(exactRecord.providerId);
        playbackProgressRef.current = {
          positionSeconds: exactRecord.positionSeconds,
          durationSeconds: exactRecord.durationSeconds,
        };
      }
      setHistoryReady(true);
    });

    return () => {
      active = false;
    };
  }, [episodeNum, id, mediaType, seasonNum]);

  const buildProgressRecord = useCallback((): ContinueWatchingRecord | null => {
    const media = mediaType === 'movie' ? movie : show;
    if (!media || !Number.isInteger(id) || id <= 0 || completedRef.current) return null;
    return {
      mediaId: id,
      mediaType,
      title: mediaType === 'movie' ? movie?.title || 'Movie' : show?.name || 'TV Show',
      posterPath: media.poster_path,
      providerId: activeProviderId,
      updatedAt: Date.now(),
      ...(seasonNum !== undefined ? { season: seasonNum } : {}),
      ...(episodeNum !== undefined ? { episode: episodeNum } : {}),
      ...(currentEpisode?.name ? { episodeName: currentEpisode.name } : {}),
      ...(playbackProgressRef.current.positionSeconds !== undefined
        ? { positionSeconds: playbackProgressRef.current.positionSeconds }
        : {}),
      ...(playbackProgressRef.current.durationSeconds !== undefined
        ? { durationSeconds: playbackProgressRef.current.durationSeconds }
        : {}),
    };
  }, [activeProviderId, currentEpisode?.name, episodeNum, id, mediaType, movie, seasonNum, show]);

  const persistLatest = useCallback(async () => {
    const record = buildProgressRecord();
    if (!record) return;
    if (isCompletedProgress(record.positionSeconds, record.durationSeconds)) {
      completedRef.current = true;
      await removeContinueWatching(id, mediaType);
      return;
    }
    await upsertContinueWatching(record);
    lastPersistedAtRef.current = Date.now();
    lastPersistedPositionRef.current = record.positionSeconds;
  }, [buildProgressRecord, id, mediaType]);

  persistLatestRef.current = persistLatest;

  useEffect(() => {
    if (historyReady && (movie || show)) void persistLatest();
  }, [historyReady, movie, persistLatest, show]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') void persistLatestRef.current();
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => () => {
    void persistLatestRef.current();
  }, []);

  const handleProgressMessage = useCallback((event: WebViewMessageEvent) => {
    const update = parseNormalPlaybackMessage(activeProviderId, event.nativeEvent.data);
    if (!update) return;

    if (update.positionSeconds !== undefined) {
      playbackProgressRef.current.positionSeconds = update.positionSeconds;
    }
    if (update.durationSeconds !== undefined) {
      playbackProgressRef.current.durationSeconds = update.durationSeconds;
    }

    if (
      update.kind === 'ended' ||
      isCompletedProgress(
        playbackProgressRef.current.positionSeconds,
        playbackProgressRef.current.durationSeconds,
      )
    ) {
      completedRef.current = true;
      void removeContinueWatching(id, mediaType);
      return;
    }

    const position = playbackProgressRef.current.positionSeconds;
    const elapsed = Date.now() - lastPersistedAtRef.current;
    const advanced =
      position !== undefined &&
      (lastPersistedPositionRef.current === undefined ||
        Math.abs(position - lastPersistedPositionRef.current) >= 5);
    if (update.kind === 'pause' || (update.kind === 'progress' && elapsed >= 10_000 && advanced)) {
      void persistLatest();
    }
  }, [activeProviderId, id, mediaType, persistLatest]);

  const toggleFullscreen = async () => {
    if (!isFullscreen) {
      setIsFullscreen(true);
      await safeSetImmersiveFullscreen(true, () => isMountedRef.current);
      await safeLockOrientation(OrientationLock.LANDSCAPE, () => isMountedRef.current);
    } else {
      setIsFullscreen(false);
      await safeSetImmersiveFullscreen(false, () => isMountedRef.current);
      await safeLockOrientation(OrientationLock.PORTRAIT_UP, () => isMountedRef.current);
    }
  };

  // Safe portrait & navbar restore on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      safeSetImmersiveFullscreen(false);
      safeLockOrientation(OrientationLock.PORTRAIT_UP);
    };
  }, []);

  useEffect(() => {
    const onBackPress = () => {
      if (isFullscreen) {
        toggleFullscreen();
        return true;
      }
      return false;
    };

    const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => {
      sub.remove();
    };
  }, [isFullscreen]);

  const handleProviderSelect = (providerId: ProviderId) => {
    void persistLatest();
    setResumePositionSeconds(playbackProgressRef.current.positionSeconds);
    setActiveProviderId(providerId);
    setWebViewError(false);
    setWebKey((prev) => prev + 1);
  };

  const handleWatchTogether = () => {
    const targetUrl =
      mediaType === 'tv'
        ? `/cowatch?type=tv&id=${id}&season=${seasonNum ?? 1}&episode=${episodeNum ?? 1}`
        : `/cowatch?type=movie&id=${id}`;
    router.push(targetUrl as any);
  };

  return (
    <View style={[styles.rootContainer, isFullscreen && styles.fullscreenRoot]}>
      <StatusBar
        hidden={isFullscreen}
        barStyle="light-content"
        backgroundColor={colors.bg.base}
      />

      {/* Top Bar (Portrait Only) */}
      {!isFullscreen && (
        <SafeAreaView style={styles.topSafeArea} edges={['top']}>
          <View style={styles.topBar}>
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => router.back()}
              activeOpacity={0.7}
            >
              <Ionicons name="chevron-back" size={22} color={colors.text.primary} />
              <Text style={styles.backText}>Back</Text>
            </TouchableOpacity>

            <View style={styles.titleWrapper}>
              <Text style={styles.topTitle} numberOfLines={1}>
                {title}
              </Text>
              {subtitle && (
                <Text style={styles.topSubtitle} numberOfLines={1}>
                  {subtitle}
                </Text>
              )}
            </View>

            <TouchableOpacity
              style={styles.cowatchPill}
              onPress={handleWatchTogether}
              activeOpacity={0.7}
            >
              <Ionicons name="people" size={14} color={colors.accent.primary} />
              <Text style={styles.cowatchPillText}>Together</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      )}

      {/* Persistent Single Playback Surface - NEVER unmounted across fullscreen transitions */}
      <View
        style={
          isFullscreen
            ? styles.fullscreenPlayerContainer
            : styles.playerContainer
        }
      >
        {!historyReady ? (
          <View style={styles.webLoading}>
            <ActivityIndicator size="large" color={colors.accent.primary} />
            <Text style={styles.loadingText}>Preparing your stream...</Text>
          </View>
        ) : !webViewError ? (
          <>
            <WebView
              key={webKey}
              source={{ uri: embedUrl }}
              style={styles.webView}
              javaScriptEnabled={true}
              domStorageEnabled={true}
              allowsFullscreenVideo={true}
              mediaPlaybackRequiresUserAction={false}
              allowsInlineMediaPlayback={true}
              setSupportMultipleWindows={false}
              javaScriptCanOpenWindowsAutomatically={false}
              onOpenWindow={() => {}}
              onShouldStartLoadWithRequest={(request) =>
                shouldAllowPlayerNavigation(
                  request.url,
                  currentProvider.baseDomain,
                  providerAdapters[activeProviderId]?.origin,
                )
              }
              injectedJavaScriptBeforeContentLoaded={PLAYER_SECURITY_BRIDGE}
              injectedJavaScript={`${PLAYER_SECURITY_BRIDGE}\n${NORMAL_PLAYER_PROGRESS_BRIDGE}`}
              onMessage={handleProgressMessage}
              onLoadEnd={() => void persistLatest()}
              onError={() => setWebViewError(true)}
              renderLoading={() => (
                <View style={styles.webLoading}>
                  <ActivityIndicator size="large" color={colors.accent.primary} />
                  <Text style={styles.loadingText}>Connecting to mirror...</Text>
                </View>
              )}
              startInLoadingState={true}
            />
            <TouchableOpacity
              style={isFullscreen ? styles.exitFullscreenBtn : styles.fullscreenBtn}
              onPress={toggleFullscreen}
              activeOpacity={0.7}
            >
              <Ionicons
                name={isFullscreen ? 'contract' : 'expand'}
                size={isFullscreen ? 20 : 16}
                color="#fff"
              />
            </TouchableOpacity>
          </>
        ) : (
          <View style={styles.errorPlayer}>
            <Ionicons name="alert-circle-outline" size={36} color={colors.accent.primary} />
            <Text style={styles.errorPlayerTitle}>Mirror Playback Error</Text>
            <Text style={styles.errorPlayerSubtitle}>
              This mirror could not load. Try selecting another provider above.
            </Text>
            <TouchableOpacity
              style={styles.retryButton}
              onPress={() => {
                setWebViewError(false);
                setWebKey((prev) => prev + 1);
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.retryText}>Retry Stream</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Portrait Scrollable Content */}
      {!isFullscreen && (
        <ScrollView
          style={styles.container}
          contentContainerStyle={styles.contentContainer}
          showsVerticalScrollIndicator={false}
        >
          {/* Provider Switcher Tabs */}
          <View style={styles.providerSection}>
            <Text style={styles.providerLabel}>STREAMING MIRRORS</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.providerRow}
            >
              {providers.map((p) => {
                const isActive = activeProviderId === p.id;
                return (
                  <TouchableOpacity
                    key={p.id}
                    style={[styles.providerTab, isActive && styles.providerTabActive]}
                    onPress={() => handleProviderSelect(p.id)}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[
                        styles.providerTabText,
                        isActive && styles.providerTabTextActive,
                      ]}
                    >
                      {p.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>

          {/* TV Episode Info Box */}
          {mediaType === 'tv' && currentEpisode && (
            <View style={styles.episodeCard}>
              <Text style={styles.episodeCardNumber}>
                SEASON {seasonNum} · EPISODE {episodeNum}
              </Text>
              <Text style={styles.episodeCardTitle}>{currentEpisode.name}</Text>
              {currentEpisode.overview ? (
                <Text style={styles.episodeCardOverview}>{currentEpisode.overview}</Text>
              ) : null}
            </View>
          )}

          {/* Mirror disclaimer */}
          <View style={styles.disclaimerBox}>
            <Ionicons name="information-circle-outline" size={14} color={colors.text.faint} />
            <Text style={styles.disclaimerText}>
              Third-party streaming mirror. If one provider buffers, select Apollo, Athena, or Hermes above.
            </Text>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  rootContainer: {
    flex: 1,
    backgroundColor: colors.bg.base,
  },
  fullscreenRoot: {
    backgroundColor: '#000',
  },
  topSafeArea: {
    backgroundColor: colors.bg.surface,
  },
  playerContainer: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#000',
    position: 'relative',
    zIndex: 5,
  },
  fullscreenPlayerContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '100%',
    backgroundColor: '#000',
    zIndex: 10,
  },
  webView: {
    flex: 1,
    width: '100%',
    height: '100%',
    backgroundColor: '#000',
  },
  exitFullscreenBtn: {
    position: 'absolute',
    top: 16,
    right: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    padding: 8,
    borderRadius: 8,
    zIndex: 15,
  },
  fullscreenBtn: {
    position: 'absolute',
    bottom: 10,
    right: 10,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    padding: 6,
    borderRadius: 6,
    zIndex: 15,
  },
  container: {
    flex: 1,
  },
  contentContainer: {
    paddingBottom: 40,
  },
  topBar: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    backgroundColor: colors.bg.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    padding: 4,
  },
  backText: {
    fontSize: 13,
    color: colors.text.primary,
    fontWeight: '600',
  },
  titleWrapper: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  topTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text.primary,
  },
  topSubtitle: {
    fontSize: 10,
    color: colors.text.secondary,
  },
  cowatchPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.accent.muted,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.accent.border,
    gap: 4,
  },
  cowatchPillText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.accent.primary,
  },
  providerSection: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
    backgroundColor: colors.bg.base,
  },
  providerLabel: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.text.faint,
    letterSpacing: 1,
    paddingHorizontal: 16,
    marginBottom: 6,
  },
  providerRow: {
    paddingHorizontal: 14,
    gap: 6,
  },
  providerTab: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.bg.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
  providerTabActive: {
    backgroundColor: colors.accent.primary,
    borderColor: colors.accent.primary,
  },
  providerTabText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.text.secondary,
  },
  providerTabTextActive: {
    color: colors.bg.base,
    fontWeight: '800',
  },
  webLoading: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bg.card,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  loadingText: {
    fontSize: 12,
    color: colors.text.secondary,
  },
  errorPlayer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: colors.bg.card,
    gap: 8,
  },
  errorPlayerTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text.primary,
  },
  errorPlayerSubtitle: {
    fontSize: 11,
    color: colors.text.secondary,
    textAlign: 'center',
    maxWidth: 260,
  },
  retryButton: {
    marginTop: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.accent.primary,
  },
  retryText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.bg.base,
  },
  episodeCard: {
    margin: 16,
    padding: 16,
    borderRadius: 14,
    backgroundColor: colors.bg.card,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    gap: 6,
  },
  episodeCardNumber: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.accent.primary,
    letterSpacing: 1.2,
  },
  episodeCardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text.primary,
  },
  episodeCardOverview: {
    fontSize: 12,
    color: colors.text.secondary,
    lineHeight: 18,
  },
  disclaimerBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    marginTop: 8,
  },
  disclaimerText: {
    fontSize: 10,
    color: colors.text.faint,
    flex: 1,
    lineHeight: 14,
  },
});
