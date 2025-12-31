package com.fitshophubmobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle

class PermissionsRationaleActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    // Minimal implementation: open your site's privacy page (or homepage) and exit.
    // Health Connect uses this activity when the user wants to see why permissions are needed.
    val url = "https://fitshop-hub.vercel.app"
    try {
      startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    } catch (_: Throwable) {
      // ignore
    }

    finish()
  }
}
