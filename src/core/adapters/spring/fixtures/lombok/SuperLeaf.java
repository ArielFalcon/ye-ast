package app;
import lombok.Builder;
import lombok.experimental.SuperBuilder;
@SuperBuilder
public class SuperLeaf extends SuperRoot {
  private String leafField;
  @Builder.Default private String defaulted = "x";
  @Builder.Default private final int locked = 1;
  private final int version = 1;
  @Builder.Default private static String kind = "k";
}
