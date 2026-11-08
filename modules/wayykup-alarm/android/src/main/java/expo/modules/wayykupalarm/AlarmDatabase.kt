package expo.modules.wayykupalarm

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.util.Log
import org.json.JSONObject

internal class AlarmDatabase(context: Context) : SQLiteOpenHelper(context, "wayykup-stats.db", null, 1) {
  override fun onCreate(database: SQLiteDatabase) {
    database.execSQL(
      """CREATE TABLE IF NOT EXISTS occurrences (
        id TEXT PRIMARY KEY NOT NULL,
        alarmId TEXT NOT NULL,
        localDate TEXT NOT NULL,
        tz TEXT NOT NULL,
        scheduledAt INTEGER NOT NULL,
        firstRingAt INTEGER,
        completedAt INTEGER,
        status TEXT NOT NULL CHECK (status IN ('scheduled','ringing','completed','bypassed','abandoned','missed','skipped')),
        challenge TEXT NOT NULL,
        difficulty INTEGER NOT NULL DEFAULT 1,
        tierReached TEXT NOT NULL DEFAULT 'gentle' CHECK (tierReached IN ('gentle','standard','brutal')),
        failedAttempts INTEGER NOT NULL DEFAULT 0,
        rearms INTEGER NOT NULL DEFAULT 0,
        soundId TEXT NOT NULL,
        morningRating INTEGER CHECK (morningRating BETWEEN 1 AND 5),
        shakesCounted INTEGER,
        steps INTEGER,
        mathCorrect INTEGER,
        mathAttempts INTEGER,
        challengeDurationMs INTEGER,
        UNIQUE (alarmId, localDate)
      )"""
    )
    database.execSQL("CREATE INDEX IF NOT EXISTS occurrences_localDate_idx ON occurrences(localDate)")
    database.execSQL("CREATE INDEX IF NOT EXISTS occurrences_scheduledAt_idx ON occurrences(scheduledAt)")
  }

  override fun onUpgrade(database: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
}

internal object OccurrenceWriter {
  private const val TAG = "WayykupAlarm"

  fun markRinging(
    context: Context,
    alarm: JSONObject,
    occurrenceId: String,
    scheduledAt: Long,
    firstRingAt: Long,
    timeZone: String,
  ) {
    val localDate = occurrenceId.substringAfterLast(':')
    val challenge = challengeFor(alarm.optString("task", "Math"))
    val soundId = alarm.optString("sound", "Air raid")
      .lowercase()
      .replace(Regex("[^a-z0-9]+"), "_")
      .trim('_')
    val db = AlarmDatabase(context).writableDatabase
    db.beginTransaction()
    try {
      db.execSQL(
        """INSERT OR IGNORE INTO occurrences
          (id, alarmId, localDate, tz, scheduledAt, status, challenge, difficulty, tierReached,
           failedAttempts, rearms, soundId)
          VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, 'gentle', 0, 0, ?)""",
        arrayOf(
          occurrenceId,
          alarm.getString("id"),
          localDate,
          timeZone,
          scheduledAt,
          challenge,
          difficultyFor(alarm),
          soundId
        )
      )
      db.execSQL(
        """UPDATE occurrences SET status='ringing', firstRingAt=COALESCE(firstRingAt, ?)
          WHERE id=? AND status IN ('scheduled','ringing')""",
        arrayOf(firstRingAt, occurrenceId)
      )
      db.setTransactionSuccessful()
      Log.i(TAG, "event=fired event=ringStarted alarmId=${alarm.optString("id")} occurrenceId=$occurrenceId at=$firstRingAt")
    } finally {
      db.endTransaction()
      db.close()
    }
  }

  fun updateRearms(context: Context, occurrenceId: String, rearmCount: Int) {
    val db = AlarmDatabase(context).writableDatabase
    try {
      db.execSQL(
        """UPDATE occurrences SET rearms=?, tierReached=CASE WHEN ? >= 3 THEN 'brutal'
          WHEN ? > 0 THEN 'standard' ELSE tierReached END WHERE id=? AND status='ringing'""",
        arrayOf(rearmCount, rearmCount, rearmCount, occurrenceId)
      )
    } finally {
      db.close()
    }
  }

  fun resolve(context: Context, occurrenceId: String, status: String) {
    if (status !in setOf("bypassed", "abandoned", "completed")) return
    val db = AlarmDatabase(context).writableDatabase
    try {
      db.execSQL(
        "UPDATE occurrences SET status=?, completedAt=CASE WHEN ?='completed' THEN COALESCE(completedAt, ?) ELSE completedAt END WHERE id=? AND status IN ('scheduled','ringing')",
        arrayOf(status, status, System.currentTimeMillis(), occurrenceId)
      )
    } finally {
      db.close()
    }
  }

  private fun challengeFor(task: String): String = when (task) {
    "Math" -> "math"
    "Shake" -> "shake"
    "QR scan" -> "qr"
    "Memory" -> "memory"
    "Object Hunt" -> "object_hunt"
    "Toothbrush" -> "toothbrush"
    else -> "exercise"
  }

  private fun difficultyFor(alarm: JSONObject): Int = when (alarm.optString("task")) {
    "Math" -> when (alarm.optString("mathDifficulty")) {
      "Hard" -> 3
      "Easy" -> 1
      else -> 2
    }
    "Shake" -> (alarm.optInt("shakeCount", 100) / 50).coerceIn(1, 4)
    else -> 1
  }
}
