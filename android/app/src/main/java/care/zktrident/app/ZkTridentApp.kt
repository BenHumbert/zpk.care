package care.zktrident.app

import android.app.Application

class ZkTridentApp : Application() {

    companion object {
        // Default URLs — override via BuildConfig or settings
        const val DEFAULT_LEVIATHAN_URL = "https://zktrident-leviathan.onrender.com"
        const val DEFAULT_PROVER_URL = "https://zktrident-prover.onrender.com"
    }

    override fun onCreate() {
        super.onCreate()
    }
}
