import SwiftUI

struct SignInView: View {
    let onSignedIn: () -> Void

    @State private var signingIn = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 40)

            JoriMark(size: 136)

            Text("Jori")
                .font(JoriTheme.display(46))
                .padding(.top, 36)

            Text("Sign in with the Google account Jori works for.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.top, 8)
                .padding(.horizontal, 32)

            Spacer(minLength: 40)

            Button(action: signIn) {
                HStack(spacing: 10) {
                    if signingIn {
                        ProgressView().controlSize(.small).tint(JoriTheme.iconDeep)
                    } else {
                        Image(systemName: "person.crop.circle.fill")
                            .contentTransition(.symbolEffect(.replace))
                    }
                    Text(signingIn ? "Opening Google…" : "Continue with Google")
                        .fontWeight(.semibold)
                        .contentTransition(.opacity)
                }
                .frame(maxWidth: 360)
                .padding(.vertical, 8)
                .foregroundStyle(JoriTheme.iconDeep)
            }
            .controlSize(.large)
            .prominentButtonStyle()
            .buttonBorderShape(.capsule)
            .disabled(signingIn)
            .keyboardShortcut(.defaultAction)
            .padding(.horizontal, 32)
            .animation(.snappy, value: signingIn)

            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(JoriTheme.deny)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                    .padding(.top, 14)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }

            Spacer().frame(height: 56)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .foregroundStyle(.white)
        .background(JoriBackdrop())
        .tint(JoriTheme.eye)
        .environment(\.colorScheme, .dark)
        .animation(.snappy, value: error)
        .sensoryFeedback(.error, trigger: error) { _, new in new != nil }
    }

    private func signIn() {
        // A build without a backend (the public defaults) can't sign in; say
        // which settings it needs rather than fail inside the web sheet.
        guard Install.isConfigured else {
            error = "This build has no server: set JORI_SUPABASE_URL and JORI_SUPABASE_ANON_KEY in Config/Installation.xcconfig."
            return
        }
        signingIn = true
        error = nil
        Task {
            do {
                try await SupabaseManager.signInWithGoogle()
                await MainActor.run {
                    signingIn = false
                    onSignedIn()
                }
            } catch {
                await MainActor.run {
                    signingIn = false
                    self.error = error.localizedDescription
                }
            }
        }
    }
}
