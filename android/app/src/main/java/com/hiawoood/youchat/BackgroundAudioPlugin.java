package com.hiawoood.youchat;

import android.content.Intent;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;

@CapacitorPlugin(name = "BackgroundAudio")
public class BackgroundAudioPlugin extends Plugin {
    private static BackgroundAudioPlugin instance;

    @Override
    public void load() {
        super.load();
        instance = this;
    }

    public static void emitState(JSObject payload) {
        if (instance != null) {
            instance.notifyListeners("stateChange", payload, false);
        }
    }

    @PluginMethod
    public void startPlayback(PluginCall call) {
        String messageId = call.getString("messageId");
        JSArray chunksArray = call.getArray("chunks");
        String baseUrl = call.getString("baseUrl");

        if (messageId == null || chunksArray == null || baseUrl == null) {
            call.reject("Missing required playback parameters.");
            return;
        }

        Intent intent = createServiceIntent(BackgroundPlaybackService.ACTION_START_PLAYBACK);
        intent.putExtra(BackgroundPlaybackService.EXTRA_MESSAGE_ID, messageId);
        intent.putStringArrayListExtra(BackgroundPlaybackService.EXTRA_CHUNKS, toArrayList(chunksArray));
        intent.putExtra(BackgroundPlaybackService.EXTRA_START_CHUNK_INDEX, call.getInt("startChunkIndex", 0));
        intent.putExtra(BackgroundPlaybackService.EXTRA_BASE_URL, baseUrl);
        intent.putExtra(BackgroundPlaybackService.EXTRA_PLAYBACK_SPEED, call.getDouble("playbackSpeed", 1d).floatValue());

        String voiceReferenceId = call.getString("voiceReferenceId");
        if (voiceReferenceId != null) {
            intent.putExtra(BackgroundPlaybackService.EXTRA_VOICE_REFERENCE_ID, voiceReferenceId);
        }

        startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        dispatchIfRunning(createServiceIntent(BackgroundPlaybackService.ACTION_PAUSE));
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        dispatchIfRunning(createServiceIntent(BackgroundPlaybackService.ACTION_RESUME));
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        dispatchIfRunning(createServiceIntent(BackgroundPlaybackService.ACTION_STOP));
        call.resolve();
    }

    @PluginMethod
    public void nextChunk(PluginCall call) {
        dispatchIfRunning(createServiceIntent(BackgroundPlaybackService.ACTION_NEXT));
        call.resolve();
    }

    @PluginMethod
    public void prevChunk(PluginCall call) {
        dispatchIfRunning(createServiceIntent(BackgroundPlaybackService.ACTION_PREV));
        call.resolve();
    }

    @PluginMethod
    public void seekToChunk(PluginCall call) {
        Intent intent = createServiceIntent(BackgroundPlaybackService.ACTION_SEEK);
        intent.putExtra(BackgroundPlaybackService.EXTRA_CHUNK_INDEX, call.getInt("chunkIndex", 0));
        dispatchIfRunning(intent);
        call.resolve();
    }

    @PluginMethod
    public void setPlaybackSpeed(PluginCall call) {
        Intent intent = createServiceIntent(BackgroundPlaybackService.ACTION_SET_SPEED);
        intent.putExtra(BackgroundPlaybackService.EXTRA_PLAYBACK_SPEED, call.getDouble("playbackSpeed", 1d).floatValue());
        dispatchIfRunning(intent);
        call.resolve();
    }

    @PluginMethod
    public void updatePlaybackChunks(PluginCall call) {
        String messageId = call.getString("messageId");
        JSArray chunksArray = call.getArray("chunks");

        if (messageId == null || chunksArray == null) {
            call.reject("Missing playback chunk update parameters.");
            return;
        }

        Intent intent = createServiceIntent(BackgroundPlaybackService.ACTION_UPDATE_CHUNKS);
        intent.putExtra(BackgroundPlaybackService.EXTRA_MESSAGE_ID, messageId);
        intent.putStringArrayListExtra(BackgroundPlaybackService.EXTRA_CHUNKS, toArrayList(chunksArray));
        dispatchIfRunning(intent);
        call.resolve();
    }

    @PluginMethod
    public void getMotionAutoStopConfig(PluginCall call) {
        JSObject payload = new JSObject();
        payload.put("enabled", readMotionAutoStopEnabled());
        call.resolve(payload);
    }

    @PluginMethod
    public void setMotionAutoStopConfig(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        persistMotionAutoStopEnabled(enabled);

        Intent intent = createServiceIntent(BackgroundPlaybackService.ACTION_SET_MOTION_AUTO_STOP);
        intent.putExtra(BackgroundPlaybackService.EXTRA_MOTION_AUTO_STOP_ENABLED, enabled);
        dispatchIfRunning(intent);

        JSObject payload = new JSObject();
        payload.put("enabled", enabled);
        call.resolve(payload);
    }

    @PluginMethod
    public void getState(PluginCall call) {
        BackgroundPlaybackService service = BackgroundPlaybackService.getInstance();
        if (service == null) {
            JSObject empty = new JSObject();
            empty.put("activeMessageId", null);
            empty.put("currentChunkIndex", 0);
            empty.put("loadingChunkIndex", null);
            empty.put("totalChunks", 0);
            empty.put("isLoading", false);
            empty.put("isPlaying", false);
            empty.put("isPaused", false);
            empty.put("error", null);
            empty.put("preparedChunkIndices", new JSArray());
            empty.put("motionAutoStopEnabled", readMotionAutoStopEnabled());
            empty.put("motionIdleRemainingMs", JSONObject.NULL);
            empty.put("motionFadeActive", false);
            call.resolve(empty);
            return;
        }

        call.resolve(service.getStatePayload());
    }

    private Intent createServiceIntent(String action) {
        Intent intent = new Intent(getContext(), BackgroundPlaybackService.class);
        intent.setAction(action);
        return intent;
    }

    private void startService(Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ContextCompat.startForegroundService(getContext(), intent);
        } else {
            getContext().startService(intent);
        }
    }

    private void dispatchIfRunning(Intent intent) {
        if (BackgroundPlaybackService.getInstance() == null) {
            return;
        }
        startService(intent);
    }

    private ArrayList<String> toArrayList(JSONArray array) {
        ArrayList<String> result = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) {
            result.add(array.optString(i));
        }
        return result;
    }

    private boolean readMotionAutoStopEnabled() {
        return getContext()
            .getSharedPreferences(BackgroundPlaybackService.PREFERENCES_NAME, android.content.Context.MODE_PRIVATE)
            .getBoolean(BackgroundPlaybackService.PREF_MOTION_AUTO_STOP_ENABLED, false);
    }

    private void persistMotionAutoStopEnabled(boolean enabled) {
        getContext()
            .getSharedPreferences(BackgroundPlaybackService.PREFERENCES_NAME, android.content.Context.MODE_PRIVATE)
            .edit()
            .putBoolean(BackgroundPlaybackService.PREF_MOTION_AUTO_STOP_ENABLED, enabled)
            .apply();
    }
}
