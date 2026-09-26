import SwiftUI

@main
struct JevPhotoApp: App {
    @StateObject private var session = Session()
    var body: some Scene {
        WindowGroup { HomeView().environmentObject(session) }
    }
}
