package app;
import lombok.Builder;
import lombok.Getter;
@Builder
@Getter
public class Order {
  private String id;
  private Person owner;
  private final int version = 1;
  private static String kind;
}
