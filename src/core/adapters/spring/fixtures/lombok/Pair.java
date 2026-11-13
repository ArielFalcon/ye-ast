package app;
public record Pair(String left, Person owner) {
  public String left() { return "declared"; }
}
