package expo.modules.wayykupalarm

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.util.Log
import java.io.File
import org.json.JSONObject

internal class AlarmDatabase(context: Context) {
  val writableDatabase: SQLiteDatabase = openDatabase(context)

  private fun openDatabase(context: Context): SQLiteDatabase {
    val directory = File(context.filesDir, "SQLite")
    check(directory.isDirectory || directory.mkdirs()) {
      "Wayykup could not create the shared Stats database directory."
    }
    val database = SQLiteDatabase.openDatabase(
      File(directory, "wayykup-stats.db").absolutePath,
      null,
      SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY,
    )
    database.execSQL("PRAGMA busy_timeout = 5000")
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
        challengeDurationMs INTEGER,
        UNIQUE (alarmId, localDate)
      )"""
    )
    database.execSQL("CREATE INDEX IF NOT EXISTS occurrences_localDate_idx ON occurrences(localDate)")
    database.execSQL("CREATE INDEX IF NOT EXISTS occurrences_scheduledAt_idx ON occurrences(scheduledAt)")
    return database
  }
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
    try {
      val localDate = occurrenceId.substringAfterLast(':')
      val challenge = challengeFor(alarm.optString("task", "Shake Your Phone"))
      val soundId = alarm.optString("sound", "police_siren")
        .lowercase()
        .replace(Regex("[^a-z0-9]+"), "_")
        .trim('_')
      val db = AlarmDatabase(context).writableDatabase
      try {
        db.beginTransaction()
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
        if (db.inTransaction()) db.endTransaction()
        db.close()
      }
    } catch (error: Exception) {
      Log.e(TAG, "Could not persist alarm ring state; the challenge will repair it on completion.", error)
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
    try {
      val db = AlarmDatabase(context).writableDatabase
      try {
        db.execSQL(
          "UPDATE occurrences SET status=?, completedAt=CASE WHEN ?='completed' THEN COALESCE(completedAt, ?) ELSE completedAt END WHERE id=? AND status IN ('scheduled','ringing')",
          arrayOf(status, status, System.currentTimeMillis(), occurrenceId)
        )
      } finally {
        db.close()
      }
    } catch (error: Exception) {
      Log.e(TAG, "Could not resolve alarm occurrence $occurrenceId as $status.", error)
    }
  }

  private fun challengeFor(task: String): String = when (task) {
    "Yell to Stop" -> "yell_to_stop"
    "Push-up Challenge" -> "push_up"
    "Shake Your Phone" -> "shake_phone"
    "Object Hunt" -> "object_hunt"
    else -> "legacy"
  }

  private fun difficultyFor(alarm: JSONObject): Int {
    val config = alarm.optJSONObject("challengeConfig")
    return when (alarm.optString("task")) {
      "Push-up Challenge" -> when (config?.optInt("targetCount", 10)) {
        5 -> 1
        10 -> 2
        else -> 3
      }
      "Shake Your Phone" -> when (config?.optInt("targetCount", 25)) {
        10, 25 -> 1
        50, 100 -> 2
        else -> 3
      }
      "Object Hunt" -> when (config?.optString("difficulty", "easy")) {
        "medium" -> 2
        "hard" -> 3
        else -> 1
      }
      else -> 1
    }
  }
}
