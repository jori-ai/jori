//
//  TradeApprovalPairingView.swift
//  Jori
//
//  One-time enrollment screen for the trade-approval second factor.
//  The user generates a pairing code in the trading web app's dashboard
//  (Pair device) and enters it here. On pairing, this device's
//  Secure Enclave public key + APNs token are registered with the web app.
//

import SwiftUI

struct TradeApprovalPairingView: View {
    @Environment(\.dismiss) private var dismiss

    @State private var code: String = ""
    @State private var working = false
    @State private var registered = TradeApproval.isRegistered
    @State private var message: String?
    @State private var isError = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if registered {
                        Label("This device is paired", systemImage: "checkmark.seal.fill")
                            .foregroundStyle(.green)
                    } else {
                        Label("Not paired", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.secondary)
                    }
                } footer: {
                    Text("Trades from \(Install.tradeApprovalLabel) require an approval tap on this phone. Approving uses Face ID and a key stored in this device's Secure Enclave.")
                }

                Section {
                    TextField("Pairing code", text: $code, prompt: Text("XXXX-XXXX"))
                        .labelsHidden()
                        #if os(iOS)
                        .textInputAutocapitalization(.characters)
                        #endif
                        .autocorrectionDisabled()
                        .font(.system(.body, design: .monospaced))

                    Button {
                        Task { await pair() }
                    } label: {
                        if working { ProgressView() } else { Text(registered ? "Re-pair this device" : "Pair this device") }
                    }
                    .disabled(working || code.trimmingCharacters(in: .whitespaces).count < 8)
                } header: {
                    Text("Pairing code")
                } footer: {
                    Text("Generate a code in the web dashboard (Settings → Pair device). Codes expire after 10 minutes.")
                }

                if let message {
                    Section {
                        Text(message).foregroundStyle(isError ? .red : .green)
                    }
                }
            }
            .formStyle(.grouped)   // the Mac's columns style clipped the label and footers
            .navigationTitle("Trade Approval")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func pair() async {
        working = true
        message = nil
        defer { working = false }
        do {
            try await TradeApproval.register(pairingCode: code)
            registered = true
            isError = false
            message = "Paired. This device can now approve trades."
            code = ""
        } catch {
            isError = true
            message = error.localizedDescription
        }
    }
}
