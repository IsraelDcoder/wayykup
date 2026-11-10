import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  challengePanel: {
    alignItems: 'center',
    backgroundColor: '#171717',
    borderRadius: 22,
    gap: 12,
    marginTop: 14,
    padding: 18,
  },
  challengeEyebrow: { color: '#FF6B6B', fontSize: 10, fontWeight: '900', letterSpacing: 1.3, textAlign: 'center' },
  challengePrompt: { color: '#FFFFFF', fontSize: 18, fontWeight: '900', letterSpacing: 0.4, textAlign: 'center' },
  challengeHint: { color: '#D5D1CE', fontSize: 12, lineHeight: 17, textAlign: 'center' },
  speechPhraseCard: { alignItems: 'center', backgroundColor: '#222823', borderColor: '#56B77B', borderRadius: 16, borderWidth: 1, justifyContent: 'center', minHeight: 72, paddingHorizontal: 16, width: '100%' },
  speechPhraseCardSuccess: { backgroundColor: '#174D2D', borderColor: '#5DDB8D' },
  speechPhraseText: { color: '#FFFFFF', fontSize: 21, fontWeight: '900', letterSpacing: 0.7, textAlign: 'center' },
  speechWave: { alignItems: 'center', flexDirection: 'row', gap: 5, height: 36, justifyContent: 'center' },
  speechWaveBar: { backgroundColor: '#59B879', borderRadius: 3, height: 8, width: 5 },
  speechWaveBarSuccess: { backgroundColor: '#8DE7AB', height: 25 },
  speechButton: { alignItems: 'center', backgroundColor: '#218B57', borderRadius: 14, justifyContent: 'center', minHeight: 50, paddingHorizontal: 24, width: '100%' },
  speechButtonListening: { backgroundColor: '#405A48' },
  speechButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900', letterSpacing: 1 },
});
