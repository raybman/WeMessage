import Foundation

/// The avatar photos the UI tests draw (S4g): three tiny synthetic PNGs,
/// abstract shapes with no face and no green, embedded as base64 because
/// the package carries no resources. Maya, Priya and Sam get one each;
/// every other rich-scenario thread falls back to initials, so a board
/// shows both. Access reads as granted and asking never reaches the
/// system. Named only here and in TestHooks (H-S4-1).
struct FixtureAvatarProvider: AvatarProvider {
  func access() async -> ContactAccess { .authorized }
  func requestAccess() async -> ContactAccess { .authorized }

  func photo(for key: String) async -> Data? {
    guard let encoded = Self.photos[key] else { return nil }
    return Data(base64Encoded: encoded, options: .ignoreUnknownCharacters)
  }

  /// Keyed by the normalised handle (AvatarKey).
  static let photos: [String: String] = [
    "+15550100001": orbit,
    "+15550100004": split,
    "sam.whitfield@example.com": steps,
  ]

  /// 72x72. Indigo field, a magenta and a rose disc.
  static let orbit = """
    iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAIAAADajyQQAAAC3ElEQVR42u2bPU9UQRSG7z8CcUFcY0OiFDQk0qDERoMNJjZS
    SEJJi3xvcAkb0YUWS0JlY+wosLQl/AyfZJLNZj/mztx7zszedZK32Nxic585Z87XzM3qE9tjqSyBJbAElsASWAJLYEL68Pxw
    Z+m4ufzl+t0pP9Dq3H6FwRZnd89fN/9+PLv/9K1fPIfwWe1zxcB46YE8/XgbC0fVAMMIuJwLVUcYtgJgv9ZaXlRebNHAiBAF
    qIxcfDIOGLGuMJXZb7mxJA6Y79bqFyFn5MAI7iWpjNFGDmxrsVEeDNlzdwSwH29ORMDs3phVcYONORj/M55gZEJFsIXJ3fXa
    8fbMaWv262X9+88nF0YXj894sjVz8vbh0dzkTmVckXeFp5vErsaj1vtaw6vqzRU9jiQYSNjHkadHLATL8erp3sjlMV7rqt4u
    RtWNd7taFiy3FM7cDYU7lUTq1p+X7TJglC8CYEsP9gkGglRGNy/ad+sqhaITGFTl3W+Yfs+f+7LZ05crGB7oHvoK282dit7U
    cfiRA6bhgYX3mz0je4BtTjcDUBnZ4yTu5zuHyywlRTAqkwPIb0QFGDqiD6DHyQ2AfmAURCHBEElSfRK8MnUQmMoYTR2scNFU
    Up16UgWMEB+FytTKimAsWyww1NPjSILF8kMj+jctsDBJeZjoTbXAIlIh0owKWOC83C/8RQUsSgbrUQJLYKatjEslVVj9N1ER
    abfMdlEeaIHJTqNiNS/ZwOFhRDASqRZYxBwt2JJlI9I+izfRg8FidS5SPYtt5hE+NkrFwxww+qKQVFf1tqC5cuaKIeO+7Igq
    B4wl1JvaK406XEfcAUpHGjBZJ3Q9bVGNkHgEaxft6qwSG4FXicrjRFP8lEzJA4ucQQue1m5ON/WQCt4aIL+Vyd0Ua1Jlrsrt
    N3adbz1JYbEydVCNe/fmWg7+OcyGbCR4WAXV7aR+l4oAg02Mwvhb+gQkgSWwBCatf5XEZ28BPvTtAAAAAElFTkSuQmCC
    """

  /// 72x72. Navy and violet on a diagonal, a white ring.
  static let split = """
    iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAIAAADajyQQAAAC8UlEQVR42t3ZzysFURQH8Pk//AX8AfZiZ4GFpNRbWClZUaIs
    2EiyUBRZKMUrGxZKKewkykLJEzZ+R5IkS1+NxjN35s79cd7cObfuwhsz13x6555zzxXUNXT6N7qaVgMvVaNtZ4GXKt9gkcor
    WLXKH1hM5QlMVPkAS1Sxh6WpeMMkKsYwuYorLFPFEqai4gdTVDGDqas4wbRUbGC6qprDWtoH+4dmJ2dWd/dPooGPuIhf1U5V
    K1hjc9/c4malcvvx/iUZuAG34WZyFT0Mb7mytiP3iAOPJPKMVcQwxJguqXrgcSoVGay+sYTFY6MKBybBVPYqGhhe5ei4Yq8K
    B6YqtZYtVQQwuSpMDx09Y9ESwg/4KE8tV6fvE93njmFpEYjrAMifxQ1pj58dvrmEpWWLkfEl9Ulwc+Ik28sPbmAIKvFt7u9f
    1StvdR1/efwUZ5vqvXAAS6xXBqowB84OXIqzHWw95w1L/Lq0IlCsVxvzd4RfmiEMaU3MFva7W+SM2LR760+5wsRknZkDVXZM
    C8PXsWnvrj/yg2EhifWKqhOBJDY5ll9OMDQdsb+NyKTqrxB7scnL0zc5wcTypRWH8n2gGI1mBS0g2W3IeyqtPTvSIMkuhAZG
    2wszg6l3IgWCZYaiusplKOomD62u0WXy0Er3ur2wy3SvXqANOnyXBVpxS2WgcrylUtkEm53GuN8Ey9sWM1Uh2hZJo2mmKkqj
    mfalocM3WOt4pEBHA5LDHASVZQS6PMyRH78hDSDFZeZAMVsU4vgt88AUyRppDYAoqPADPuKiWK+KdWCKUWot41WojrhJVASw
    MAfiVdKCSmtgEhKVLSyW2bHcbVSW2YIMllivsIRQfHRJeMQms1PC5FUYbylPD9WphZxkDlPfW6DyoulAjGHxRAMfcdFsz15D
    mP3/GvMZgZcqPRgjlQaMl0oVxk6lBOOoyoYxVWXA+KpkMNaqVBh3VTLMA1UCzA9VHOaN6h/MJ9UfzDPVL8w/1Q/MSxXGN4AV
    f2foN2hLAAAAAElFTkSuQmCC
    """

  /// 72x72. Concentric blue, slate and white squares.
  static let steps = """
    iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAIAAADajyQQAAAAqElEQVR42u3asQ3CQAwF0Nso+1BRXIvYANEQUTIAAzBSSqoM
    EKVIiVc4hE44etJvLd8rfXYZztMuU8DAwMDAwMDSwQ718rcBAwMDAwP7FlZP4/X+7JBo1BUWLddl65BoBAYGBgYG1hF2e83H
    x7spUZIAFg9tHeOjBAwMDAwMDAwMDAwMDMyg6c8DDAwMDCwrbLerWlcDYGBgYGAZYK64wcDAwMDAwH6YD6YuG1iSZOlGAAAA
    AElFTkSuQmCC
    """
}
