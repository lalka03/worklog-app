package com.worklog.app.yandex.test;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

@CapacitorPlugin(name = "RememberedSession")
public class RememberedSessionPlugin extends Plugin {
    private static final String ALIAS = "worklog.remembered-session.v1";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final int IV_SIZE = 12;
    private static final int TAG_BITS = 128;

    private AtomicFile file() {
        return new AtomicFile(new File(getContext().getNoBackupFilesDir(), "remembered-session.v1"));
    }

    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        if (!create) return null;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }

    private boolean valid(String token) {
        return token != null && token.matches("[A-Za-z0-9_-]{22,128}");
    }

    private void erase() throws Exception {
        AtomicFile target = file();
        target.delete();
        File base = target.getBaseFile();
        if (base.exists() || new File(base.getPath() + ".bak").exists() || new File(base.getPath() + ".new").exists()) {
            // Even if a damaged filesystem cannot remove ciphertext, destroy its key.
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            if (store.containsAlias(ALIAS)) store.deleteEntry(ALIAS);
            if (store.containsAlias(ALIAS)) throw new IllegalStateException("Unable to remove remembered session");
        }
    }

    private void empty(PluginCall call) {
        JSObject result = new JSObject();
        result.put("token", JSONObject.NULL);
        call.resolve(result);
    }

    @PluginMethod
    public synchronized void get(PluginCall call) {
        try {
            AtomicFile source = file();
            File base = source.getBaseFile();
            if (!base.exists() && !new File(base.getPath() + ".bak").exists()) { empty(call); return; }
            byte[] data = source.readFully();
            SecretKey secret = key(false);
            if (secret == null || data.length < IV_SIZE + 16 || data.length > IV_SIZE + 16 + 128) {
                erase(); empty(call); return;
            }
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.DECRYPT_MODE, secret, new GCMParameterSpec(TAG_BITS, Arrays.copyOf(data, IV_SIZE)));
            String token = new String(cipher.doFinal(data, IV_SIZE, data.length - IV_SIZE), StandardCharsets.UTF_8);
            if (!valid(token)) { erase(); empty(call); return; }
            JSObject result = new JSObject();
            result.put("token", token);
            call.resolve(result);
        } catch (AEADBadTagException invalid) {
            try { erase(); empty(call); }
            catch (Exception failure) { call.reject("Protected session unavailable"); }
        } catch (Exception failure) {
            call.reject("Protected session unavailable");
        }
    }

    @PluginMethod
    public synchronized void set(PluginCall call) {
        String token = call.getString("token");
        if (!valid(token)) { call.reject("Invalid refresh credential"); return; }
        AtomicFile target = file();
        FileOutputStream output = null;
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.ENCRYPT_MODE, key(true));
            byte[] iv = cipher.getIV();
            if (iv.length != IV_SIZE) throw new IllegalStateException("Unexpected IV length");
            byte[] encrypted = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
            byte[] expected = new byte[iv.length + encrypted.length];
            System.arraycopy(iv, 0, expected, 0, iv.length);
            System.arraycopy(encrypted, 0, expected, iv.length, encrypted.length);
            output = target.startWrite();
            output.write(expected);
            target.finishWrite(output);
            output = null;
            if (!Arrays.equals(expected, target.readFully())) throw new IllegalStateException("Remembered session write failed");
            call.resolve();
        } catch (Exception failure) {
            if (output != null) target.failWrite(output);
            call.reject("Protected session unavailable");
        }
    }

    @PluginMethod
    public synchronized void clear(PluginCall call) {
        try { erase(); call.resolve(); }
        catch (Exception failure) { call.reject("Protected session unavailable"); }
    }
}
