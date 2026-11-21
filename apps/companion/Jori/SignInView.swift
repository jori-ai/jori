import SwiftUI

struct SignInView: View {
    let onSignedIn: () -> Void

    @State private var signingIn = false
    @State private var error: String?
    /// A shared (public) build with no backend yet starts at "Find your Jori";
    /// a build with its own backend, or a paired one, goes straight to sign-in.
    @State private var findingJori = !Install.isConfigured
    /// Email sign-in (no Google needed): nil = not started, then the address,
    /// then the code Supabase emailed.
    @State private var emailMode = false
    @State private var email = PairingStore.current?.ownerEmail ?? ""
    @State private var codeSent = false
    @State private var code = ""

    var body: some View {
        if findingJori {
            FindJoriView(onPaired: { withAnimation(.smooth) { findingJori = false } },
                         onCancel: Install.isConfigured ? { withAnimation(.smooth) { findingJori = false } } : nil)
                .transition(.opacity)
        } else {
            signIn
                .transition(.opacity)
        }
    }

    private var signIn: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 40)

            JoriMark(size: 136)

            Text(Install.displayName)
                .font(JoriTheme.display(46))
                .padding(.top, 36)

            Text(emailMode ? "Sign in with a code sent to your email." : "Sign in with the Google account \(Install.displayName) works for.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.top, 8)
                .padding(.horizontal, 32)

            // A pairing may say whose Jori it is (a hint; Google decides).
            if let email = PairingStore.current?.ownerEmail {
                Text(email)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(JoriTheme.eye)
                    .padding(.top, 6)
            }

            Spacer(minLength: 40)

            if emailMode {
                emailSignIn
            } else {
            Button(action: startSignIn) {
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
            }

            Button(emailMode ? "Use Google instead" : "Email me a code instead") {
                error = nil
                withAnimation(.smooth) { emailMode.toggle() }
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.top, 14)
            .disabled(signingIn)

            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(JoriTheme.deny)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                    .padding(.top, 14)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }

            // Only a paired app can switch: a build with its own backend looks
            // exactly as it always has.
            if PairingStore.current != nil {
                Button("Use another Jori") {
                    error = nil
                    withAnimation(.smooth) { findingJori = true }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.top, 18)
                .disabled(signingIn)
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

    private var emailSignIn: some View {
        VStack(spacing: 12) {
            TextField("you@example.com", text: $email)
                .textContentType(.emailAddress)
                #if os(iOS)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                #endif
                .autocorrectionDisabled()
                .padding(12)
                .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                .disabled(codeSent || signingIn)
            if codeSent {
                TextField("Code from the email", text: $code)
                    .textContentType(.oneTimeCode)
                    #if os(iOS)
                    .keyboardType(.numberPad)
                    #endif
                    .padding(12)
                    .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                    .disabled(signingIn)
            }
            Button(action: codeSent ? verifyCode : sendCode) {
                HStack(spacing: 10) {
                    if signingIn { ProgressView().controlSize(.small).tint(JoriTheme.iconDeep) }
                    Text(codeSent ? "Sign in" : "Email me a code").fontWeight(.semibold)
                }
                .frame(maxWidth: 360)
                .padding(.vertical, 8)
                .foregroundStyle(JoriTheme.iconDeep)
            }
            .controlSize(.large)
            .prominentButtonStyle()
            .buttonBorderShape(.capsule)
            .disabled(signingIn || (codeSent ? code.trimmingCharacters(in: .whitespaces).count < 6 : !email.contains("@")))
            if codeSent {
                Button("Send another code") { codeSent = false; code = "" }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: 360)
        .padding(.horizontal, 32)
    }

    private func sendCode() {
        guard Install.isConfigured else { withAnimation(.smooth) { findingJori = true }; return }
        signingIn = true
        error = nil
        let address = email.trimmingCharacters(in: .whitespaces).lowercased()
        Task {
            do {
                try await SupabaseManager.sendEmailCode(to: address)
                await MainActor.run { signingIn = false; codeSent = true }
            } catch {
                await MainActor.run { signingIn = false; self.error = error.localizedDescription }
            }
        }
    }

    private func verifyCode() {
        signingIn = true
        error = nil
        let address = email.trimmingCharacters(in: .whitespaces).lowercased()
        let token = code.trimmingCharacters(in: .whitespaces)
        Task {
            do {
                try await SupabaseManager.verifyEmailCode(email: address, code: token)
                await MainActor.run { signingIn = false; onSignedIn() }
            } catch {
                await MainActor.run { signingIn = false; self.error = error.localizedDescription }
            }
        }
    }

    private func startSignIn() {
        // No backend (the shared app, not yet paired): find one first rather
        // than fail inside the web sheet.
        guard Install.isConfigured else {
            withAnimation(.smooth) { findingJori = true }
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
