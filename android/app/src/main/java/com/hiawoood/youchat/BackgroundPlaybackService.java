package com.hiawoood.youchat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.PlaybackParams;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Base64;
import android.webkit.CookieManager;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.media.app.NotificationCompat.MediaStyle;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;

public class BackgroundPlaybackService extends Service {
    public static final String ACTION_START_PLAYBACK = "com.hiawoood.youchat.action.START_PLAYBACK";
    public static final String ACTION_PAUSE = "com.hiawoood.youchat.action.PAUSE";
    public static final String ACTION_RESUME = "com.hiawoood.youchat.action.RESUME";
    public static final String ACTION_STOP = "com.hiawoood.youchat.action.STOP";
    public static final String ACTION_NEXT = "com.hiawoood.youchat.action.NEXT";
    public static final String ACTION_PREV = "com.hiawoood.youchat.action.PREV";
    public static final String ACTION_SEEK = "com.hiawoood.youchat.action.SEEK";
    public static final String ACTION_SET_SPEED = "com.hiawoood.youchat.action.SET_SPEED";

    public static final String EXTRA_MESSAGE_ID = "messageId";
    public static final String EXTRA_CHUNKS = "chunks";
    public static final String EXTRA_START_CHUNK_INDEX = "startChunkIndex";
    public static final String EXTRA_VOICE_REFERENCE_ID = "voiceReferenceId";
    public static final String EXTRA_PLAYBACK_SPEED = "playbackSpeed";
    public static final String EXTRA_BASE_URL = "baseUrl";
    public static final String EXTRA_CHUNK_INDEX = "chunkIndex";

    private static final String CHANNEL_ID = "you-chat-tts-playback";
    private static final int NOTIFICATION_ID = 4207;

    private static volatile BackgroundPlaybackService instance;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService fetchExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService metadataExecutor = Executors.newSingleThreadExecutor();
    private final AtomicInteger sessionGeneration = new AtomicInteger(0);
    private final Map<Integer, Future<?>> fetchTasks = new ConcurrentHashMap<>();
    private final Map<Integer, File> preparedChunkFiles = new ConcurrentHashMap<>();
    private final Set<Integer> preparedChunkIndices = ConcurrentHashMap.newKeySet();

    private MediaPlayer mediaPlayer;
    private MediaSessionCompat mediaSession;
    private PowerManager.WakeLock wakeLock;

    private String activeMessageId;
    private ArrayList<String> chunkTexts = new ArrayList<>();
    private String baseUrl;
    private String voiceReferenceId;
    private float playbackSpeed = 1f;

    private int currentChunkIndex = 0;
    private int loadingChunkIndex = -1;
    private boolean isLoading = false;
    private boolean isPlaying = false;
    private boolean isPaused = false;
    private String errorMessage = null;

    public static BackgroundPlaybackService getInstance() {
        return instance;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createNotificationChannel();
        acquireWakeLock();
        createMediaSession();
        startForeground(NOTIFICATION_ID, buildNotification());
        publishState();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || intent.getAction() == null) {
            return START_STICKY;
        }

        switch (intent.getAction()) {
            case ACTION_START_PLAYBACK -> handleStartPlayback(intent);
            case ACTION_PAUSE -> pausePlayback();
            case ACTION_RESUME -> resumePlayback();
            case ACTION_STOP -> stopPlayback(true);
            case ACTION_NEXT -> skipToChunk(currentChunkIndex + 1);
            case ACTION_PREV -> skipToChunk(currentChunkIndex - 1);
            case ACTION_SEEK -> skipToChunk(intent.getIntExtra(EXTRA_CHUNK_INDEX, currentChunkIndex));
            case ACTION_SET_SPEED -> setPlaybackSpeedInternal(intent.getFloatExtra(EXTRA_PLAYBACK_SPEED, playbackSpeed));
            default -> {
            }
        }

        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopPlayback(false);
        if (mediaSession != null) {
          mediaSession.release();
          mediaSession = null;
        }
        releaseWakeLock();
        fetchExecutor.shutdownNow();
        metadataExecutor.shutdownNow();
        instance = null;
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    public JSObject getStatePayload() {
        JSObject payload = new JSObject();
        payload.put("activeMessageId", activeMessageId);
        payload.put("currentChunkIndex", currentChunkIndex);
        payload.put("loadingChunkIndex", loadingChunkIndex >= 0 ? loadingChunkIndex : JSONObject.NULL);
        payload.put("totalChunks", chunkTexts.size());
        payload.put("isLoading", isLoading);
        payload.put("isPlaying", isPlaying);
        payload.put("isPaused", isPaused);
        payload.put("error", errorMessage == null ? JSONObject.NULL : errorMessage);

        JSArray prepared = new JSArray();
        preparedChunkIndices.stream().sorted().forEach(prepared::put);
        payload.put("preparedChunkIndices", prepared);
        return payload;
    }

    private void handleStartPlayback(Intent intent) {
        final int generation = sessionGeneration.incrementAndGet();
        stopCurrentPlayer();
        clearPreparedChunks();

        activeMessageId = intent.getStringExtra(EXTRA_MESSAGE_ID);
        baseUrl = intent.getStringExtra(EXTRA_BASE_URL);
        voiceReferenceId = intent.getStringExtra(EXTRA_VOICE_REFERENCE_ID);
        playbackSpeed = intent.getFloatExtra(EXTRA_PLAYBACK_SPEED, 1f);
        currentChunkIndex = Math.max(0, intent.getIntExtra(EXTRA_START_CHUNK_INDEX, 0));
        loadingChunkIndex = currentChunkIndex;
        isLoading = true;
        isPlaying = false;
        isPaused = false;
        errorMessage = null;

        chunkTexts = intent.getStringArrayListExtra(EXTRA_CHUNKS);
        if (chunkTexts == null) {
            chunkTexts = new ArrayList<>();
        }

        publishState();
        playChunk(currentChunkIndex, generation);
    }

    private void playChunk(int chunkIndex, int generation) {
        if (generation != sessionGeneration.get()) return;
        if (chunkIndex < 0 || chunkIndex >= chunkTexts.size()) {
            completePlayback();
            return;
        }

        currentChunkIndex = chunkIndex;
        loadingChunkIndex = chunkIndex;
        isLoading = true;
        isPlaying = false;
        isPaused = false;
        errorMessage = null;
        publishState();

        ensurePrefetch(chunkIndex, generation);

        File preparedFile = preparedChunkFiles.get(chunkIndex);
        if (preparedFile != null && preparedFile.exists()) {
            startPreparedChunk(chunkIndex, preparedFile, generation);
        }
    }

    private void ensurePrefetch(int chunkIndex, int generation) {
        for (int index = chunkIndex; index <= Math.min(chunkTexts.size() - 1, chunkIndex + 2); index++) {
            queueChunkFetch(index, generation);
        }
    }

    private void queueChunkFetch(int chunkIndex, int generation) {
        if (chunkIndex < 0 || chunkIndex >= chunkTexts.size()) return;
        if (preparedChunkFiles.containsKey(chunkIndex) || fetchTasks.containsKey(chunkIndex)) return;

        Future<?> task = fetchExecutor.submit(() -> {
            try {
                File file = fetchChunkAudioToFile(chunkIndex, chunkTexts.get(chunkIndex));
                if (generation != sessionGeneration.get()) {
                    if (file.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        file.delete();
                    }
                    return;
                }

                preparedChunkFiles.put(chunkIndex, file);
                preparedChunkIndices.add(chunkIndex);
                fetchTasks.remove(chunkIndex);
                publishState();

                if (chunkIndex == currentChunkIndex && isLoading) {
                    mainHandler.post(() -> startPreparedChunk(chunkIndex, file, generation));
                }
            } catch (Exception error) {
                fetchTasks.remove(chunkIndex);
                if (generation != sessionGeneration.get()) return;

                errorMessage = error.getMessage();
                isLoading = false;
                isPlaying = false;
                isPaused = true;
                loadingChunkIndex = -1;
                publishState();
            }
        });

        fetchTasks.put(chunkIndex, task);
    }

    private void startPreparedChunk(int chunkIndex, File file, int generation) {
        if (generation != sessionGeneration.get()) return;
        if (!file.exists()) {
            queueChunkFetch(chunkIndex, generation);
            return;
        }

        stopCurrentPlayer();

        try {
            mediaPlayer = new MediaPlayer();
            mediaPlayer.setAudioAttributes(
                new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            );
            mediaPlayer.setDataSource(file.getAbsolutePath());
            mediaPlayer.setOnPreparedListener(player -> {
                if (generation != sessionGeneration.get()) return;

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    PlaybackParams params = new PlaybackParams();
                    params.setSpeed(playbackSpeed);
                    player.setPlaybackParams(params);
                }

                player.start();
                currentChunkIndex = chunkIndex;
                loadingChunkIndex = -1;
                isLoading = false;
                isPlaying = true;
                isPaused = false;
                errorMessage = null;
                ensurePrefetch(chunkIndex + 1, generation);
                saveProgress(chunkIndex);
                publishState();
            });
            mediaPlayer.setOnCompletionListener(player -> handleChunkCompleted(chunkIndex, generation));
            mediaPlayer.setOnErrorListener((player, what, extra) -> {
                errorMessage = "Native playback failed.";
                isLoading = false;
                isPlaying = false;
                isPaused = true;
                loadingChunkIndex = -1;
                publishState();
                return true;
            });
            mediaPlayer.prepareAsync();
        } catch (Exception error) {
            errorMessage = error.getMessage();
            isLoading = false;
            isPlaying = false;
            isPaused = true;
            loadingChunkIndex = -1;
            publishState();
        }
    }

    private void handleChunkCompleted(int completedChunkIndex, int generation) {
        if (generation != sessionGeneration.get()) return;

        int nextChunkIndex = completedChunkIndex + 1;
        if (nextChunkIndex >= chunkTexts.size()) {
            completePlayback();
            return;
        }

        playChunk(nextChunkIndex, generation);
    }

    private void pausePlayback() {
        if (mediaPlayer != null && mediaPlayer.isPlaying()) {
            mediaPlayer.pause();
        }

        isPlaying = false;
        isPaused = true;
        publishState();
    }

    private void resumePlayback() {
        if (mediaPlayer != null && !mediaPlayer.isPlaying() && !isLoading) {
            mediaPlayer.start();
            isPlaying = true;
            isPaused = false;
            publishState();
            return;
        }

        playChunk(currentChunkIndex, sessionGeneration.get());
    }

    private void skipToChunk(int chunkIndex) {
        int boundedIndex = Math.max(0, Math.min(chunkTexts.size() - 1, chunkIndex));
        playChunk(boundedIndex, sessionGeneration.incrementAndGet());
    }

    private void setPlaybackSpeedInternal(float nextPlaybackSpeed) {
        playbackSpeed = nextPlaybackSpeed;
        if (mediaPlayer != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                PlaybackParams params = mediaPlayer.getPlaybackParams();
                params.setSpeed(playbackSpeed);
                mediaPlayer.setPlaybackParams(params);
            } catch (Exception ignored) {
            }
        }
        publishState();
    }

    private void completePlayback() {
        stopPlayback(true);
    }

    private void stopPlayback(boolean stopService) {
        sessionGeneration.incrementAndGet();
        stopCurrentPlayer();
        clearPreparedChunks();
        activeMessageId = null;
        chunkTexts = new ArrayList<>();
        currentChunkIndex = 0;
        loadingChunkIndex = -1;
        isLoading = false;
        isPlaying = false;
        isPaused = false;
        errorMessage = null;
        publishState();

        if (stopService) {
            stopSelf();
        }
    }

    private void stopCurrentPlayer() {
        if (mediaPlayer != null) {
            try {
                mediaPlayer.stop();
            } catch (Exception ignored) {
            }
            mediaPlayer.reset();
            mediaPlayer.release();
            mediaPlayer = null;
        }
    }

    private void clearPreparedChunks() {
        fetchTasks.values().forEach((task) -> task.cancel(true));
        fetchTasks.clear();
        preparedChunkIndices.clear();
        for (File file : preparedChunkFiles.values()) {
            if (file.exists()) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        }
        preparedChunkFiles.clear();
    }

    private File fetchChunkAudioToFile(int chunkIndex, String text) throws Exception {
        byte[] audioBytes = null;
        Exception lastException = null;

        for (int attempt = 0; attempt < 3; attempt++) {
            try {
                audioBytes = requestChunkAudio(text);
                break;
            } catch (Exception error) {
                lastException = error;
                Thread.sleep(1200L);
            }
        }

        if (audioBytes == null) {
            throw lastException != null ? lastException : new Exception("Failed to generate chunk audio.");
        }

        File outputFile = new File(getCacheDir(), "tts-" + sessionGeneration.get() + "-" + chunkIndex + ".wav");
        try (BufferedOutputStream outputStream = new BufferedOutputStream(new FileOutputStream(outputFile))) {
            outputStream.write(audioBytes);
            outputStream.flush();
        }
        return outputFile;
    }

    private byte[] requestChunkAudio(String text) throws Exception {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(baseUrl + "/api/tts/speak");
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(30000);
            connection.setReadTimeout(210000);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Accept", "application/json");
            connection.setDoOutput(true);

            String cookies = CookieManager.getInstance().getCookie(baseUrl);
            if (cookies != null && !cookies.isEmpty()) {
                connection.setRequestProperty("Cookie", cookies);
            }

            JSONObject payload = new JSONObject();
            payload.put("text", text);
            if (voiceReferenceId != null) {
                payload.put("voiceReferenceId", voiceReferenceId);
            }

            try (OutputStream outputStream = connection.getOutputStream()) {
                outputStream.write(payload.toString().getBytes(StandardCharsets.UTF_8));
            }

            int statusCode = connection.getResponseCode();
            InputStream responseStream = statusCode >= 200 && statusCode < 300
                ? connection.getInputStream()
                : connection.getErrorStream();

            String responseBody = readStream(responseStream);
            if (statusCode < 200 || statusCode >= 300) {
                throw new Exception(responseBody.isEmpty() ? "TTS request failed." : responseBody);
            }

            JSONObject response = new JSONObject(responseBody);
            String audioBase64 = response.optString("audio", "");
            if (audioBase64.isEmpty()) {
                throw new Exception(response.optString("error", "TTS audio payload was empty."));
            }

            return Base64.decode(audioBase64, Base64.DEFAULT);
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private void saveProgress(int chunkIndex) {
        if (activeMessageId == null || baseUrl == null) return;

        metadataExecutor.submit(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(baseUrl + "/api/tts/progress/" + activeMessageId);
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("PATCH");
                connection.setConnectTimeout(10000);
                connection.setReadTimeout(15000);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setDoOutput(true);

                String cookies = CookieManager.getInstance().getCookie(baseUrl);
                if (cookies != null && !cookies.isEmpty()) {
                    connection.setRequestProperty("Cookie", cookies);
                }

                JSONObject payload = new JSONObject();
                payload.put("chunkIndex", chunkIndex);

                try (OutputStream outputStream = connection.getOutputStream()) {
                    outputStream.write(payload.toString().getBytes(StandardCharsets.UTF_8));
                }

                connection.getResponseCode();
            } catch (Exception ignored) {
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }
        });
    }

    private String readStream(InputStream inputStream) throws Exception {
        if (inputStream == null) return "";

        try (BufferedReader reader = new BufferedReader(new InputStreamReader(new BufferedInputStream(inputStream), StandardCharsets.UTF_8))) {
            StringBuilder builder = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                builder.append(line);
            }
            return builder.toString();
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "You Chat TTS Playback",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Keeps You Chat TTS playback active with media controls.");

        NotificationManager notificationManager = getSystemService(NotificationManager.class);
        if (notificationManager != null) {
            notificationManager.createNotificationChannel(channel);
        }
    }

    private void createMediaSession() {
        mediaSession = new MediaSessionCompat(this, "YouChatTtsSession");
        mediaSession.setFlags(MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS | MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS);
        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() {
                resumePlayback();
            }

            @Override
            public void onPause() {
                pausePlayback();
            }

            @Override
            public void onSkipToNext() {
                skipToChunk(currentChunkIndex + 1);
            }

            @Override
            public void onSkipToPrevious() {
                skipToChunk(currentChunkIndex - 1);
            }

            @Override
            public void onStop() {
                stopPlayback(true);
            }
        });
        mediaSession.setActive(true);
    }

    private Notification buildNotification() {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent contentIntent = null;

        if (launchIntent != null) {
            int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;
            contentIntent = PendingIntent.getActivity(this, 0, launchIntent, flags);
        }

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("You Chat")
            .setContentText(buildNotificationText())
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOnlyAlertOnce(true)
            .setOngoing(isPlaying || isLoading)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .addAction(createAction(android.R.drawable.ic_media_previous, "Previous", ACTION_PREV))
            .addAction(isPlaying
                ? createAction(android.R.drawable.ic_media_pause, "Pause", ACTION_PAUSE)
                : createAction(android.R.drawable.ic_media_play, "Play", ACTION_RESUME))
            .addAction(createAction(android.R.drawable.ic_media_next, "Next", ACTION_NEXT))
            .addAction(createAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", ACTION_STOP))
            .setStyle(new MediaStyle().setMediaSession(mediaSession.getSessionToken()).setShowActionsInCompactView(0, 1, 2));

        if (contentIntent != null) {
            builder.setContentIntent(contentIntent);
        }

        return builder.build();
    }

    private NotificationCompat.Action createAction(int iconRes, String title, String action) {
        Intent intent = new Intent(this, BackgroundPlaybackService.class);
        intent.setAction(action);

        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
            ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            : PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent pendingIntent = PendingIntent.getService(this, action.hashCode(), intent, flags);
        return new NotificationCompat.Action(iconRes, title, pendingIntent);
    }

    private String buildNotificationText() {
        if (chunkTexts.isEmpty()) {
            return "TTS playback is ready";
        }
        if (isLoading && loadingChunkIndex >= 0) {
            return "Loading chunk " + (loadingChunkIndex + 1) + " of " + chunkTexts.size();
        }
        return "Playing chunk " + (currentChunkIndex + 1) + " of " + chunkTexts.size();
    }

    private void updateMediaSession() {
        if (mediaSession == null) return;

        long actions = PlaybackStateCompat.ACTION_PLAY_PAUSE
            | PlaybackStateCompat.ACTION_PLAY
            | PlaybackStateCompat.ACTION_PAUSE
            | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
            | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
            | PlaybackStateCompat.ACTION_STOP;

        int state = isPlaying
            ? PlaybackStateCompat.STATE_PLAYING
            : isPaused
                ? PlaybackStateCompat.STATE_PAUSED
                : isLoading
                    ? PlaybackStateCompat.STATE_BUFFERING
                    : PlaybackStateCompat.STATE_STOPPED;

        mediaSession.setPlaybackState(new PlaybackStateCompat.Builder()
            .setActions(actions)
            .setState(state, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, playbackSpeed)
            .build());

        mediaSession.setMetadata(new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, "You Chat TTS")
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, buildNotificationText())
            .build());
    }

    private void publishState() {
        updateMediaSession();
        NotificationManager notificationManager = getSystemService(NotificationManager.class);
        if (notificationManager != null) {
            notificationManager.notify(NOTIFICATION_ID, buildNotification());
        }
        BackgroundAudioPlugin.emitState(getStatePayload());
    }

    private void acquireWakeLock() {
        PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
        if (powerManager == null || wakeLock != null) return;

        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "youchat:native-tts");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
    }
}
