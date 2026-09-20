import SwiftUI
import UIKit

final class ShareViewController: UIViewController {
    private var model: ShareViewModel?

    override func viewDidLoad() {
        super.viewDidLoad()
        guard let extensionContext else {
            cancel()
            return
        }

        let model = ShareViewModel(context: extensionContext)
        model.onCancel = { [weak self] in self?.cancel() }
        model.onComplete = { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
        self.model = model

        let host = UIHostingController(rootView: ShareRootView(model: model))
        addChild(host)
        view.addSubview(host.view)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
        preferredContentSize = CGSize(width: 0, height: 640)
    }

    private func cancel() {
        let error = NSError(
            domain: NSCocoaErrorDomain,
            code: NSUserCancelledError
        )
        extensionContext?.cancelRequest(withError: error)
    }
}
