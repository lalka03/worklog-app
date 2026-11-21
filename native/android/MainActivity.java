package com.worklog.app.yandex.test;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RememberedSessionPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
