import SwiftUI
import LocalAuthentication

struct LockScreen: View {
    @Binding var isUnlocked: Bool
    @Environment(\.scenePhase) private var scenePhase
    @State private var authFailed = false
    @State private var authenticating = false

    private var biometryName: String {
        let context = LAContext()
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch context.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return "Passcode"
        }
    }

    private var biometrySymbol: String {
        switch biometryName {
        case "Face ID": return "faceid"
        case "Touch ID": return "touchid"
        case "Optic ID": return "opticid"
        default: return "lock.fill"
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            JoriMark(size: 112)

            Text("Jori")
                .font(JoriTheme.display(40))
                .padding(.top, 32)

            Group {
                if authenticating {
                    ProgressView()
                        .controlSize(.regular)
                } else if authFailed {
                    // Without this the only way back in was to leave the app
                    // and come back, which re-armed the prompt.
                    Button(action: authenticate) {
                        Label("Unlock with \(biometryName)", systemImage: biometrySymbol)
                            .fontWeight(.semibold)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .foregroundStyle(JoriTheme.iconDeep)
                    }
                    .controlSize(.large)
                    .prominentButtonStyle()
                    .buttonBorderShape(.capsule)
                    .keyboardShortcut(.defaultAction)
                    .transition(.scale(scale: 0.9).combined(with: .opacity))
                }
            }
            .frame(height: 56)
            .padding(.top, 24)
            .animation(.snappy, value: authenticating)
            .animation(.snappy, value: authFailed)

            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .foregroundStyle(.white)
        .background(JoriBackdrop())
        .tint(JoriTheme.eye)
        .environment(\.colorScheme, .dark)
        .sensoryFeedback(.error, trigger: authFailed) { _, failed in failed }
        .onAppear {
            authenticate()
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active && !isUnlocked && !authenticating {
                authenticate()
            }
        }
    }

    private func authenticate() {
        guard !authenticating else { return }
        authenticating = true

        let context = LAContext()
        var error: NSError?

        let policy: LAPolicy = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
            ? .deviceOwnerAuthenticationWithBiometrics
            : .deviceOwnerAuthentication

        context.evaluatePolicy(policy, localizedReason: "Unlock Jori") { success, _ in
            DispatchQueue.main.async {
                authenticating = false
                if success {
                    isUnlocked = true
                    authFailed = false
                } else {
                    authFailed = true
                }
            }
        }
    }
}
