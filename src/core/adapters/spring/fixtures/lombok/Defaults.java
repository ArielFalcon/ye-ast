package app;
import lombok.Builder;
@Builder
public class Defaults {
  @Builder.Default private final String label = "x";
  @Builder.Default private static String kind = "k";
  private final int version = 1;
}
