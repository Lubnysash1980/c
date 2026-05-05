package com.cybra.nfcbridge

import android.app.PendingIntent
import android.content.Intent
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import okhttp3.*
import java.io.IOException
import java.util.*

class MainActivity : AppCompatActivity() {
    private var nfcAdapter: NfcAdapter? = null
    private val client = OkHttpClient()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        nfcAdapter = NfcAdapter.getDefaultAdapter(this)
        if (nfcAdapter == null) {
            Toast.makeText(this, "NFC not supported on this device", Toast.LENGTH_LONG).show()
        } else if (!nfcAdapter!!.isEnabled) {
            Toast.makeText(this, "NFC is disabled. Enable it in settings.", Toast.LENGTH_LONG).show()
            try {
                startActivity(Intent(Settings.ACTION_NFC_SETTINGS))
            } catch (e: Exception) {
            }
        }

        // If app was opened from an NFC intent, handle it
        intent?.let { handleIntent(it) }
    }

    override fun onResume() {
        super.onResume()
        nfcAdapter?.let { adapter ->
            val intent = Intent(this, javaClass).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            val pending = PendingIntent.getActivity(this, 0, intent, if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
            try {
                adapter.enableForegroundDispatch(this, pending, null, null)
            } catch (e: Exception) {
            }
        }
    }

    override fun onPause() {
        super.onPause()
        try {
            nfcAdapter?.disableForegroundDispatch(this)
        } catch (e: Exception) {
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent) {
        val action = intent.action
        if (action == NfcAdapter.ACTION_TAG_DISCOVERED || action == NfcAdapter.ACTION_TECH_DISCOVERED || action == NfcAdapter.ACTION_NDEF_DISCOVERED) {
            val tag: Tag? = intent.getParcelableExtra(NfcAdapter.EXTRA_TAG)
            tag?.let {
                val idBytes = it.id
                val idHex = bytesToHex(idBytes)
                Toast.makeText(this, "Tag: $idHex", Toast.LENGTH_SHORT).show()
                // send to default local server (can be configured in UI later)
                val server = "http://10.0.2.2:5000/nfc"
                sendTag(server, idHex)
            }
        }
    }

    private fun bytesToHex(bytes: ByteArray?): String {
        if (bytes == null) return ""
        val sb = StringBuilder()
        for (b in bytes) {
            sb.append(String.format("%02X", b))
        }
        return sb.toString()
    }

    private fun sendTag(server: String, tag: String) {
        val json = "{\"number\":\"" + tag + "\"}"
        val body = RequestBody.create(MediaType.get("application/json; charset=utf-8"), json)
        val req = Request.Builder().url(server).post(body).build()
        client.newCall(req).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "Send failed: ${'$'}{e.message}", Toast.LENGTH_LONG).show()
                }
            }
            override fun onResponse(call: Call, response: Response) {
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "Sent, code: ${'$'}{response.code()}", Toast.LENGTH_SHORT).show()
                }
            }
        })
    }
}
