package app;

public class StatementsBeforeThis {
  public StatementsBeforeThis(int x) {
    if (x < 0) throw new IllegalArgumentException("{");
    this(x, 1);
  }

  public StatementsBeforeThis(int x, int y) {}
}
