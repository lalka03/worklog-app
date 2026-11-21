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
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(name = "RememberedSession")
public class RememberedSessionPlugin extends Plugin {
    private static final String ALIAS = "worklog.remembered-session.v1";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final int IV_SIZE = 12;
    private static final int TAG_BITS = 128;
    private static final int MAX_PLAINTEXT_BYTES = 4096;
    private static final int MAX_CIPHERTEXT_BYTES = IV_SIZE + TAG_BITS / 8 + MAX_PLAINTEXT_BYTES;
    private static final long MAX_GRANT_MS = 30L * 24 * 60 * 60 * 1000;
    private static final long MAX_LOCAL_MS = 8640000000000000L;

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

    private boolean validToken(Object token) {
        return token instanceof String && ((String) token).matches("[A-Za-z0-9_-]{22,128}");
    }

    private boolean validUser(JSONObject user) {
        Object uid = user.opt("uid");
        Object email = user.opt("email");
        Object role = user.opt("role");
        if (user.length() != 3 || !(uid instanceof String)
                || !((String) uid).matches("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")
                || !(email instanceof String) || !("employee".equals(role) || "admin".equals(role))) return false;
        String address = (String) email;
        return address.length() <= 254 && address.indexOf('@') <= 64
                && address.matches("[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*"
                        + "@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
                        + "(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+");
    }

    private long serverTimestamp(Object value) {
        if (!(value instanceof String)) return -1;
        String timestamp = (String) value;
        if (!timestamp.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")) return -1;
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        format.setLenient(false);
        Date parsed = format.parse(timestamp, new ParsePosition(0));
        return parsed == null ? -1 : parsed.getTime();
    }

    private long localTimestamp(Object value) {
        if (!(value instanceof Integer || value instanceof Long)) return -1;
        long timestamp = ((Number) value).longValue();
        return timestamp > 0 && timestamp <= MAX_LOCAL_MS ? timestamp : -1;
    }

    private boolean validRecord(JSONObject record) {
        JSONObject grant = record.optJSONObject("grant");
        if (record.length() != 2 || !validToken(record.opt("token")) || grant == null
                || grant.length() != 6 || !Integer.valueOf(1).equals(grant.opt("version"))) return false;
        JSONObject user = grant.optJSONObject("user");
        if (user == null || !validUser(user)) return false;
        long serverTime = serverTimestamp(grant.opt("serverTime"));
        long expiresAt = serverTimestamp(grant.opt("refreshExpiresAt"));
        long verified = localTimestamp(grant.opt("verifiedLocalMs"));
        long checked = localTimestamp(grant.opt("checkedLocalMs"));
        return serverTime > 0 && expiresAt > serverTime && expiresAt - serverTime <= MAX_GRANT_MS
                && verified > 0 && checked >= verified;
    }

    private byte[] readCiphertext(AtomicFile source) throws Exception {
        // Limit allocation before decryption, including when the on-disk file is corrupt.
        byte[] buffer = new byte[MAX_CIPHERTEXT_BYTES + 1];
        try (InputStream input = source.openRead()) {
            int position = 0;
            while (position < buffer.length) {
                int count = input.read(buffer, position, buffer.length - position);
                if (count == -1) break;
                position += count;
            }
            return Arrays.copyOf(buffer, position);
        }
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
            byte[] data = readCiphertext(source);
            SecretKey secret = key(false);
            if (secret == null || data.length <= IV_SIZE + TAG_BITS / 8 || data.length > MAX_CIPHERTEXT_BYTES) {
                erase(); empty(call); return;
            }
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.DECRYPT_MODE, secret, new GCMParameterSpec(TAG_BITS, Arrays.copyOf(data, IV_SIZE)));
            String plaintext = new String(cipher.doFinal(data, IV_SIZE, data.length - IV_SIZE), StandardCharsets.UTF_8);
            JSObject result = new JSObject();
            if (validToken(plaintext)) {
                result.put("token", plaintext);
            } else {
                JSONObject record = new JSONObject(plaintext);
                // Encrypted records are written as compact JSON. Reject permissive parses of malformed JSON.
                if (!validRecord(record) || !plaintext.equals(record.toString())) { erase(); empty(call); return; }
                result.put("token", record.opt("token"));
                result.put("grant", record.optJSONObject("grant"));
            }
            call.resolve(result);
        } catch (AEADBadTagException | JSONException invalid) {
            try { erase(); empty(call); }
            catch (Exception failure) { call.reject("Protected session unavailable"); }
        } catch (Exception failure) {
            call.reject("Protected session unavailable");
        }
    }

    @PluginMethod
    public synchronized void set(PluginCall call) {
        JSONObject record = call.getData();
        Object token = record.opt("token");
        boolean legacy = record.length() == 1 && validToken(token);
        if (!legacy && !validRecord(record)) { call.reject("Invalid refresh credential"); return; }
        byte[] plaintext = (legacy ? (String) token : record.toString()).getBytes(StandardCharsets.UTF_8);
        if (plaintext.length > MAX_PLAINTEXT_BYTES) { call.reject("Invalid refresh credential"); return; }
        AtomicFile target = file();
        FileOutputStream output = null;
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.ENCRYPT_MODE, key(true));
            byte[] iv = cipher.getIV();
            if (iv.length != IV_SIZE) throw new IllegalStateException("Unexpected IV length");
            byte[] encrypted = cipher.doFinal(plaintext);
            byte[] expected = new byte[iv.length + encrypted.length];
            System.arraycopy(iv, 0, expected, 0, iv.length);
            System.arraycopy(encrypted, 0, expected, iv.length, encrypted.length);
            output = target.startWrite();
            output.write(expected);
            target.finishWrite(output);
            output = null;
            if (!Arrays.equals(expected, readCiphertext(target))) throw new IllegalStateException("Remembered session write failed");
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
