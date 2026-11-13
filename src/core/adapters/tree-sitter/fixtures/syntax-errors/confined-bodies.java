package app;

public class Bodies {
  {
    int = 1;
  }

  static {
    int = 2;
  }

  Runnable task = () -> { int = 3; };

  void missing() { work() }

  void nested() {
    run(() -> {
      int = 4;
    });
  }

  void kept() {}
}
